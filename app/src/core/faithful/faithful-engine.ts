// Orquestrador do Motor de Captura Fiel (CDP + Autoscroll + Reescrita + ZIP)

import { zipSync } from 'fflate';
import { FaithfulCaptureOptions, FaithfulCaptureResult, CapturedResource, FaithfulCaptureWarnings } from './types';
import { watchTargetTab } from './tab-guard';
import { CdpNetworkRecorder, isDebuggerDetachedError, sanitizeUrlForStorage, MAX_CDP_RESOURCES, MAX_CDP_BYTES } from './cdp-recorder';
import { performAutoscroll } from './autoscroll';
import {
  mapUrlToZipPath,
  rewriteHtmlDocument,
  rewriteCssContent,
  rewriteJsContent
} from './rewriter';
import { createCrawlSession, extractCrawlLinks, enqueueDiscoveredLinks, recordDownloadedBytes, isUrlInCrawlScope } from './crawler';
import {
  generateReadmeText,
  generateAbrirBat,
  generateAbrirPs1,
  generateAbrirSh,
  generateOfflineFallbackHtml
} from './opener-scripts';
import { safePath } from '../security/safe-path';
import { validateUrl, isLocalhostPage } from '../security/url-guard';
import { isValidDocumentHtml } from '../capture/capture-engine';
import { isSpaSkeleton, serializeLiveDom, isHeavySpa } from './dom-serializer';

export async function captureFaithfulSite(
  options: FaithfulCaptureOptions
): Promise<FaithfulCaptureResult> {
  const tabId = options.tabId;
  const pageUrl = options.url;
  const pageTitle = options.title || 'Site Fiel';
  const mode = options.mode || 'page';
  const autoscrollEnabled = options.autoscroll !== false;

  let recorder: CdpNetworkRecorder | null = null;
  const files: Record<string, Uint8Array> = {};
  const urlToZipMap = new Map<string, string>();
  let totalBytes = 0;
  let brokenImagesCount = 0;
  let externalAssetsCount = 0;
  let pagesCount = 0;
  let failedPages = 0;
  let attemptedSubpages = 0;
  let networkLost = false;
  let mainStatus: number | undefined;
  const ownGuard = !options.tabGuard && tabId !== undefined && typeof chrome !== 'undefined' && !!chrome.tabs;
  const guard = options.tabGuard || (ownGuard ? watchTargetTab(tabId!, pageUrl) : null);
  // Debugger que cai porque a aba fechou vira captura parcial, não erro
  const detachIsInterruption = (err: unknown): boolean => {
    if (!isDebuggerDetachedError(err)) return false;
    if (err.reason === 'target_closed') guard?.interrupt('tab_closed');
    return Boolean(guard?.reason);
  };

  try {
    // 1. Inicializa o Gravador CDP se houver tabId
    if (options.recorder) {
      try {
        options.recorder.throwIfDetached();
        recorder = options.recorder;
      } catch (err) {
        if (!detachIsInterruption(err)) throw err;
      }
    } else if (tabId && typeof chrome !== 'undefined' && chrome.debugger) {
      recorder = new CdpNetworkRecorder(tabId);
      try {
        await recorder.start();
      } catch (cdpErr) {
        console.warn('Aviso: Não foi possível anexar chrome.debugger:', cdpErr);
        recorder = null;
      }
    }

    guard?.onInterrupted((r) => {
      if (r === 'navigated_away') recorder?.freeze(guard.interruptedAt);
    });

    // 2. Executa autoscroll se habilitado
    if (autoscrollEnabled && !guard?.reason) {
      if (options.onProgress) {
        options.onProgress(0, 100, 'Executando autoscroll e ativando animações...');
      }

      const scrollOpts = {
        step: 400,
        intervalMs: 150,
        ...(options.autoscrollOptions || {})
      };

      if (tabId && typeof chrome !== 'undefined' && chrome.scripting) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: performAutoscroll,
            args: [scrollOpts]
          });
        } catch {
          if (recorder) {
            try {
              await recorder.evaluate(`(${performAutoscroll.toString()})(${JSON.stringify(scrollOpts)})`);
            } catch (err) {
              if (!detachIsInterruption(err) && isDebuggerDetachedError(err)) throw err;
            }
          }
        }
      }
    }

    // 3. Captura o DOM serializado da página principal após o autoscroll
    let mainHtml = options.html || '';

    // Se temos tabId e scripting, captura o DOM vivo após o autoscroll para preservar
    // Shadow DOM Declarativo (<template shadowrootmode="open">), imagens resolvidas e nós hidratados
    if (tabId && !guard?.reason && typeof chrome !== 'undefined' && chrome.scripting) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: serializeLiveDom
        });
        if (!guard?.reason && results && results[0]?.result && isValidDocumentHtml(results[0].result)) {
          mainHtml = results[0].result;
        }
      } catch (err) {
        console.warn('executeScript serializeLiveDom falhou no faithful-engine:', err);
      }
    }

    if ((!mainHtml || isSpaSkeleton(mainHtml) || !mainHtml.includes('shadowrootmode=')) && recorder && !guard?.reason) {
      try {
        const cdpHtml = await recorder.evaluate(`(${serializeLiveDom.toString()})()`);
        if (!guard?.reason && cdpHtml && isValidDocumentHtml(cdpHtml)) mainHtml = cdpHtml;
      } catch (err) {
        if (!detachIsInterruption(err) && isDebuggerDetachedError(err)) throw err;
        console.warn('CDP evaluate serializeLiveDom falhou no faithful-engine:', err);
      }
    }

    // HTML carimbado com outra origem = DOM lido depois que a aba saiu do site: descarta e busca o original
    const htmlOrigin = stampedSourceOrigin(mainHtml);
    if (htmlOrigin && htmlOrigin !== new URL(pageUrl).origin) {
      guard?.interrupt('navigated_away');
      recorder?.freeze(guard?.interruptedAt);
      mainHtml = await fetchOriginalHtml(pageUrl);
    }
    mainHtml = mainHtml.replace(SOURCE_STAMP_RE, '');

    if (!isValidDocumentHtml(mainHtml)) {
      throw new Error(`Falha crítica no Modo Fiel: DOM da página principal vazio ou inacessível (${pageUrl}).`);
    }

    // 4. Coleta recursos gravados pelo CDP ou fornecidos via customResources (gravação manual)
    let capturedResources: CapturedResource[] = [];
    if (options.customResources && Array.isArray(options.customResources)) {
      capturedResources.push(...options.customResources);
    }
    if (recorder) {
      mainStatus = recorder.getDocumentStatus(pageUrl);
    }
    if (recorder && guard?.reason !== 'tab_closed') {
      if (options.onProgress) {
        options.onProgress(50, 100, 'Coletando recursos de rede via CDP...');
      }
      try {
        const cdpResources = await recorder.collectResources((loaded, total, item) => {
          if (options.onProgress) {
            options.onProgress(loaded, total, item);
          }
        });
        capturedResources.push(...cdpResources);
      } catch (err) {
        if (!detachIsInterruption(err)) throw err;
      }
    }

    // 5. Mapeia todos os recursos capturados para caminhos dentro do ZIP
    for (const res of capturedResources) {
      // Ignora recursos HTML secundários ou vazios coletados por prefetch no CDP
      const isHtml = res.mimeType.includes('html') || res.url.endsWith('.html');
      const isEmpty = typeof res.data === 'string' ? res.data.length === 0 : res.data.byteLength === 0;
      if (isHtml && (isEmpty || mode === 'page')) {
        continue;
      }

      const zipPath = mapUrlToZipPath(res.url, pageUrl);
      if (!zipPath) continue; // [FIEL-09] Ignora URLs rejeitadas por política de segurança
      urlToZipMap.set(res.url, zipPath);
      if (zipPath.startsWith('_external/')) {
        externalAssetsCount++;
      }
    }

    // Registra a página inicial
    urlToZipMap.set(pageUrl, 'index.html');
    pagesCount = 1;

    // 5.1 Baixa estaticamente qualquer recurso declarado no HTML (menu, hover, srcset, masks, imagens CDN)
    // que não tenha sido acionado pelo browser durante o autoscroll do CDP.
    // Captura interrompida (aba fechou/saiu do site) não busca mais nada na rede: devolve o parcial já.
    const staticDownloads = guard?.reason ? { addedBytes: 0, externalCount: 0 } : await downloadMissingStaticAssets(
      mainHtml,
      pageUrl,
      pageUrl,
      urlToZipMap,
      files,
      {
        maxResources: MAX_CDP_RESOURCES,
        maxBytes: MAX_CDP_BYTES,
        currentTotalBytes: totalBytes
      }
    );
    totalBytes += staticDownloads.addedBytes;
    externalAssetsCount += staticDownloads.externalCount;

    // 5.2 Baixa fontes ou imagens declaradas em CSS capturados pelo CDP que não foram requisitadas
    for (const res of capturedResources) {
      if (guard?.reason) break;
      if ((res.mimeType.includes('css') || res.url.endsWith('.css')) && typeof res.data === 'string') {
        const cssDownloads = await downloadMissingStaticAssets(
          res.data,
          res.url,
          pageUrl,
          urlToZipMap,
          files,
          {
            maxResources: MAX_CDP_RESOURCES,
            maxBytes: MAX_CDP_BYTES,
            currentTotalBytes: totalBytes
          }
        );
        totalBytes += cssDownloads.addedBytes;
        externalAssetsCount += cssDownloads.externalCount;
      }
    }

    // 5.3 Baixa modelos 3D, WASM, Rive, texturas e assets declarados em scripts JavaScript baixados ou coletados via CDP
    const jsSources: { url: string; content: string }[] = [];
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('.js') || name.endsWith('.mjs')) {
        let jsUrl = pageUrl;
        for (const [orig, mapped] of urlToZipMap.entries()) {
          if (mapped === name) { jsUrl = orig; break; }
        }
        jsSources.push({ url: jsUrl, content: new TextDecoder().decode(bytes) });
      }
    }
    for (const res of capturedResources) {
      if (res.mimeType.includes('javascript') || res.url.endsWith('.js') || res.url.endsWith('.mjs')) {
        const text = typeof res.data === 'string' ? res.data : new TextDecoder().decode(res.data);
        jsSources.push({ url: res.url, content: text });
      }
    }

    const seenJsUrls = new Set<string>();
    for (const jsItem of jsSources) {
      if (guard?.reason) break;
      if (seenJsUrls.has(jsItem.url)) continue;
      seenJsUrls.add(jsItem.url);

      const jsDownloads = await downloadMissingStaticAssets(
        jsItem.content,
        jsItem.url,
        pageUrl,
        urlToZipMap,
        files,
        {
          maxResources: MAX_CDP_RESOURCES,
          maxBytes: MAX_CDP_BYTES,
          currentTotalBytes: totalBytes
        }
      );
      totalBytes += jsDownloads.addedBytes;
      externalAssetsCount += jsDownloads.externalCount;
    }

    // 6. Sessão de Crawler (se modo linked ou site)
    const crawlSession = createCrawlSession(pageUrl, options.limits);
    if (mode === 'linked' || mode === 'site') {
      const initialLinks = extractCrawlLinks(mainHtml, pageUrl, crawlSession);
      enqueueDiscoveredLinks(crawlSession, initialLinks, 0);

      const isRootLocal = isLocalhostPage(pageUrl);
      // Interrupção cancela a subpágina em andamento; teto de 20 s para nenhum fetch ficar pendurado
      const crawlAbort = new AbortController();
      guard?.onInterrupted(() => crawlAbort.abort());

      while (crawlSession.queuedUrls.length > 0 && !crawlSession.isFinished) {
        // Checa parada geral solicitada pelo usuário ("Parar e salvar")
        if ((options.shouldStop && options.shouldStop()) || options.signal?.aborted || guard?.reason) {
          crawlSession.isFinished = true;
          break;
        }

        // Checa se o usuário solicitou pular a página atual ("Pular a página atual")
        if (options.shouldSkipCurrent && options.shouldSkipCurrent()) {
          crawlSession.queuedUrls.shift();
          continue;
        }

        const next = crawlSession.queuedUrls.shift();
        if (!next || crawlSession.visitedUrls.has(next.url)) continue;

        // [FIEL-03] Valida URL antes de executar requisição (SSRF guard)
        const preCheck = validateUrl(next.url, isRootLocal);
        if (!preCheck.valid) {
          console.warn('[Crawler SSRF Guard] Ignorando URL inválida/privada:', next.url);
          continue;
        }

        crawlSession.visitedUrls.add(next.url);
        const subPageZip = mapUrlToZipPath(next.url, pageUrl);
        if (!subPageZip) continue;

        urlToZipMap.set(next.url, subPageZip);
        pagesCount++;
        // A raiz volta à fila do crawler, mas já foi capturada da aba: não entra nos avisos
        const isRootRefetch = next.url === crawlSession.rootUrl;
        if (!isRootRefetch) attemptedSubpages++;

        let actualSubPageZip = subPageZip;
        try {
          const res = await fetch(next.url, { signal: AbortSignal.any([crawlAbort.signal, AbortSignal.timeout(20000)]) });
          // [FIEL-03] Valida destino final após redirecionamento e verifica se está no escopo de crawl
          if (res.url) {
            const destCheck = validateUrl(res.url, isRootLocal);
            if (!destCheck.valid) {
              console.warn('[Crawler SSRF Guard] Redirecionamento bloqueado:', res.url);
              continue;
            }
            if (
              !isUrlInCrawlScope(
                res.url,
                crawlSession.rootOrigin,
                crawlSession.rootHostname,
                crawlSession.limits.includeSubdomains,
                crawlSession.limits.allowedExternalDomains || []
              )
            ) {
              console.warn('[Crawler] Redirecionamento para domínio fora do escopo permitido:', res.url);
              continue;
            }
            if (res.url !== next.url) {
              const mappedDestZip = mapUrlToZipPath(res.url, pageUrl);
              if (mappedDestZip) {
                actualSubPageZip = mappedDestZip;
                urlToZipMap.set(res.url, actualSubPageZip);
                urlToZipMap.set(res.url.split('?')[0], actualSubPageZip);
                urlToZipMap.set(next.url, actualSubPageZip);
                urlToZipMap.set(next.url.split('?')[0], actualSubPageZip);
              }
            }
          }

          if (!res.ok && !isRootRefetch) failedPages++;
          if (res.ok) {
            const subHtml = await res.text();
            if (guard?.reason) break; // saiu da origem/fechou durante o download: não salva a página
            recordDownloadedBytes(crawlSession, subHtml.length);
            const subLinks = extractCrawlLinks(subHtml, res.url || next.url, crawlSession);
            enqueueDiscoveredLinks(crawlSession, subLinks, next.depth);

            // Descobre e baixa recursos estáticos da subpágina (imagens, css, fontes, scripts, etc.)
            const subDownloads = await downloadMissingStaticAssets(
              subHtml,
              res.url || next.url,
              pageUrl,
              urlToZipMap,
              files,
              {
                maxResources: MAX_CDP_RESOURCES,
                maxBytes: MAX_CDP_BYTES,
                currentTotalBytes: totalBytes
              }
            );
            totalBytes += subDownloads.addedBytes;
            externalAssetsCount += subDownloads.externalCount;

            // Reescreve e salva a subpágina
            const rewrittenSubHtml = rewriteHtmlDocument(
              subHtml,
              res.url || next.url,
              actualSubPageZip,
              urlToZipMap,
              false,
              isHeavySpa(res.url || next.url, subHtml)
            );
            const encodedSub = new TextEncoder().encode(rewrittenSubHtml);
            files[actualSubPageZip] = encodedSub;
            totalBytes += encodedSub.byteLength;
          }
        } catch {
          if (guard?.reason) break; // fetch cancelado pela interrupção: não é falha de página
          // Subpágina inacessível: conta como falha; offline no navegador = a rede caiu
          if (!isRootRefetch) failedPages++;
          if (typeof navigator !== 'undefined' && navigator.onLine === false) networkLost = true;
        }
      }
    }

    // 7. Processa e adiciona recursos ao ZIP
    for (const res of capturedResources) {
      const isHtml = res.mimeType.includes('html') || res.url.endsWith('.html');
      const isEmpty = typeof res.data === 'string' ? res.data.length === 0 : res.data.byteLength === 0;
      if (isHtml && (isEmpty || mode === 'page')) {
        continue;
      }

      const zipPath = urlToZipMap.get(res.url) || mapUrlToZipPath(res.url, pageUrl);
      if (!zipPath) continue;

      // [FIEL-06] Teto global de arquivos e bytes acumulados no ZIP
      if (Object.keys(files).length >= MAX_CDP_RESOURCES || totalBytes >= MAX_CDP_BYTES) {
        console.warn('[Faithful Engine] Teto global de arquivos/tamanho atingido.');
        break;
      }

      let dataBytes: Uint8Array;

      if (typeof res.data === 'string') {
        // Se for CSS, reescreve url() e @import
        if (res.mimeType.includes('css') || zipPath.endsWith('.css')) {
          const rewrittenCss = rewriteCssContent(res.data, res.url, zipPath, urlToZipMap);
          dataBytes = new TextEncoder().encode(rewrittenCss);
        } else if (res.mimeType.includes('javascript') || zipPath.endsWith('.js') || zipPath.endsWith('.mjs')) {
          const rewrittenJs = rewriteJsContent(res.data, zipPath, urlToZipMap);
          dataBytes = new TextEncoder().encode(rewrittenJs);
        } else {
          dataBytes = new TextEncoder().encode(res.data);
        }
      } else {
        dataBytes = res.data;
      }

      // [WASM Guard] Valida integridade para arquivos WebAssembly (.wasm)
      if (zipPath.endsWith('.wasm')) {
        if (dataBytes.byteLength < 8) {
          console.warn('[Faithful Engine] WASM coletado via CDP vazio (< 8 bytes), rejeitado:', res.url);
          continue;
        }
        if (dataBytes[0] !== 0x00 || dataBytes[1] !== 0x61 || dataBytes[2] !== 0x73 || dataBytes[3] !== 0x6d) {
          console.warn('[Faithful Engine] WASM coletado via CDP sem magic bytes 0061736d, rejeitado:', res.url);
          continue;
        }
      }

      const prevLen = files[zipPath]?.byteLength || 0;
      files[zipPath] = dataBytes;
      totalBytes += (dataBytes.byteLength - prevLen);

      // Garante que o par rive.wasm / rive_fallback.wasm esteja presente no pacote
      if (zipPath.endsWith('/rive.wasm') || zipPath === 'rive.wasm') {
        const fallbackZip = zipPath.replace(/rive\.wasm$/, 'rive_fallback.wasm');
        if (!files[fallbackZip]) {
          files[fallbackZip] = dataBytes;
          urlToZipMap.set(res.url.replace(/rive\.wasm$/, 'rive_fallback.wasm'), fallbackZip);
        }
      } else if (zipPath.endsWith('/rive_fallback.wasm') || zipPath === 'rive_fallback.wasm') {
        const mainZip = zipPath.replace(/rive_fallback\.wasm$/, 'rive.wasm');
        if (!files[mainZip]) {
          files[mainZip] = dataBytes;
          urlToZipMap.set(res.url.replace(/rive_fallback\.wasm$/, 'rive.wasm'), mainZip);
        }
      }
    }

    // 7.1 Reescreve todos os arquivos CSS presentes em files (incluindo os baixados via crawler)
    // para garantir que referências a fontes (.woff2), SVGs e imagens de fundo apontem para caminhos relativos locais
    for (const zipPath of Object.keys(files)) {
      if (zipPath.endsWith('.css')) {
        let originalCssUrl = '';
        for (const [rawUrl, tz] of urlToZipMap.entries()) {
          if (tz === zipPath) {
            originalCssUrl = rawUrl;
            break;
          }
        }
        if (!originalCssUrl) {
          originalCssUrl = pageUrl;
        }
        try {
          const cssText = new TextDecoder().decode(files[zipPath]);
          const rewrittenCss = rewriteCssContent(cssText, originalCssUrl, zipPath, urlToZipMap);
          const rewrittenBytes = new TextEncoder().encode(rewrittenCss);
          const prevLen = files[zipPath]?.byteLength || 0;
          files[zipPath] = rewrittenBytes;
          totalBytes += (rewrittenBytes.byteLength - prevLen);
        } catch {}
      }
    }

    // 8. Reescreve e salva a página HTML principal
    const isSinglePage = mode === 'page';
    const disableAppScripts = isHeavySpa(pageUrl, mainHtml);
    const rewrittenMainHtml = rewriteHtmlDocument(
      mainHtml,
      pageUrl,
      'index.html',
      urlToZipMap,
      isSinglePage,
      disableAppScripts
    );
    const mainHtmlBytes = new TextEncoder().encode(rewrittenMainHtml);
    files['index.html'] = mainHtmlBytes;
    totalBytes += mainHtmlBytes.byteLength;

    // 8.0 Adiciona página de fallback offline amigável para rotas não capturadas
    const fallbackHtml = generateOfflineFallbackHtml(pageTitle, pageUrl);
    const fallbackBytes = new TextEncoder().encode(fallbackHtml);
    files['offline-fallback.html'] = fallbackBytes;
    totalBytes += fallbackBytes.byteLength;

    // 8.1. Grava urlmap.json com todas as URLs capturadas pelo CDP higienizadas (FIEL-04)
    const urlMapJsonObj: Record<string, string> = {};
    for (const [rawUrl, targetZip] of urlToZipMap.entries()) {
      if (!rawUrl.startsWith('data:') && !rawUrl.startsWith('blob:') && targetZip) {
        const cleanUrl = sanitizeUrlForStorage(rawUrl);
        urlMapJsonObj[cleanUrl] = targetZip;
      }
    }
    const urlMapBytes = new TextEncoder().encode(JSON.stringify(urlMapJsonObj, null, 2));
    files['urlmap.json'] = urlMapBytes;
    totalBytes += urlMapBytes.byteLength;

    // 9. Adiciona os scripts e instruções de abertura offline
    files['README.txt'] = new TextEncoder().encode(generateReadmeText(pageTitle, pageUrl));
    files['abrir.bat'] = new TextEncoder().encode(generateAbrirBat());
    files['abrir.ps1'] = new TextEncoder().encode(generateAbrirPs1());
    files['abrir.sh'] = new TextEncoder().encode(generateAbrirSh());

    // 10. Gera o arquivo ZIP final (nunca entrega ZIP de captura cuja depuração caiu no meio)
    if (!guard?.reason) recorder?.throwIfDetached();
    const zipData = zipSync(files, { level: 6 });
    const blob = new Blob([zipData], { type: 'application/zip' });
    const cleanName = safePath(pageTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-'));

    const warnings: FaithfulCaptureWarnings = {};
    if (mainStatus !== undefined && mainStatus >= 400) warnings.mainStatus = mainStatus;
    if (failedPages > 0 || networkLost) {
      warnings.failedPages = failedPages;
      warnings.totalPages = 1 + attemptedSubpages;
    }
    if (networkLost) warnings.networkLost = true;

    return {
      filename: `${cleanName || 'site'}-fiel.zip`,
      blob,
      stats: {
        totalPages: pagesCount,
        totalAssets: Object.keys(files).length,
        totalBytes,
        brokenImages: brokenImagesCount,
        externalAssets: externalAssetsCount
      },
      files,
      ...(guard?.reason ? { interrupted: guard.reason } : {}),
      ...(Object.keys(warnings).length ? { warnings } : {})
    };
  } finally {
    if (ownGuard) guard?.stop();
    if (recorder) {
      await recorder.stop().catch(() => {});
    }
  }
}

const SOURCE_STAMP_RE = /<!--pluck-source-origin:([^>]*?)-->/;

function stampedSourceOrigin(html: string): string | null {
  const m = SOURCE_STAMP_RE.exec(html || '');
  return m ? m[1] : null;
}

// HTML original da página quando o DOM vivo já é de outro site (parcial da origem certa)
async function fetchOriginalHtml(pageUrl: string): Promise<string> {
  try {
    const res = await fetch(pageUrl, { credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (res.ok && validateUrl(res.url || pageUrl, isLocalhostPage(pageUrl)).valid && new URL(res.url || pageUrl).origin === new URL(pageUrl).origin) {
      return await res.text();
    }
  } catch {}
  return '';
}

// Extrai candidatos a recursos estáticos declarados em HTML, CSS ou atributos
export function extractStaticAssetCandidates(
  html: string,
  baseUrl: string
): string[] {
  const candidates = new Set<string>();

  // 1. Tags padrão: img, source, video, audio, link, script
  const tagRegexes = [
    /<img\b[^>]*\bsrc=["']([^"']+)["']/gi,
    /<source\b[^>]*\bsrc=["']([^"']+)["']/gi,
    /<video\b[^>]*\bsrc=["']([^"']+)["']/gi,
    /<video\b[^>]*\bposter=["']([^"']+)["']/gi,
    /<audio\b[^>]*\bsrc=["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
    /<script\b[^>]*\bsrc=["']([^"']+)["']/gi
  ];
  for (const regex of tagRegexes) {
    for (const match of html.matchAll(regex)) {
      if (match[1]) candidates.add(match[1]);
    }
  }

  // 2. Atributos srcset (em img ou source)
  const srcsetRegex = /(?:srcset)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(srcsetRegex)) {
    const parts = match[1].split(',');
    for (const part of parts) {
      const u = part.trim().split(/\s+/)[0];
      if (u) candidates.add(u);
    }
  }

  // 3. Estilos inline ou tags style com url(...)
  const urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  for (const match of html.matchAll(urlRegex)) {
    if (match[1]) candidates.add(match[1]);
  }

  // 4. Atributos comuns de lazy loading ou mídia
  const dataSrcRegex = /\bdata-(?:src|original|lazy|srcset|bg)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(dataSrcRegex)) {
    if (match[1]) candidates.add(match[1]);
  }

  // 5. URLs de CDN absolutas ou protocol-relative com extensões de mídia/3D/fontes conhecidas (com suporte a query strings)
  const cdnRegex = /(?:https?:)?\/\/[^\s"'<>\(\)]+\.(?:webp|png|jpg|jpeg|svg|gif|ico|avif|woff2|woff|ttf|wasm|glb|gltf|riv|hdr|bin|json)(?:\?[^\s"'<>\(\)]*)?/gi;
  for (const match of html.matchAll(cdnRegex)) {
    candidates.add(match[0]);
  }

  // 5.1 URLs de thumbnails e avatares do YouTube (i.ytimg.com, yt3.ggpht.com)
  const ytCdnRegex = /(?:https?:)?\/\/(?:[a-zA-Z0-9_\-\.]+\.)?(?:ytimg\.com|ggpht\.com)\/[^\s"'<>\(\)]+/gi;
  for (const match of html.matchAll(ytCdnRegex)) {
    candidates.add(match[0]);
  }

  // 6. Caminhos relativos de assets estáticos conhecidos (precedidos por aspas, parênteses ou espaço)
  const relRegex = /(?:^|[\s"'\(=])(?:\/)?(?:images|_next\/static|static|gl|rive|models|hdri|textures|fonts)\/[a-zA-Z0-9_\-\.\/]+\.(?:webp|png|jpg|jpeg|svg|gif|ico|avif|woff2|woff|ttf|wasm|glb|gltf|riv|hdr|bin|json)/gi;
  for (const match of html.matchAll(relRegex)) {
    const clean = match[0].replace(/^[\s"'\(=]+/, '');
    if (clean) candidates.add(clean);
  }

  // 7. Rive WASM npm packages montados dinamicamente em bundles JS (ex: "name":"@rive-app/canvas-lite","version":"2.26.4")
  const rivePkgRegex = /"name"\s*:\s*"(@rive-app\/[^"]+)"\s*,\s*"version"\s*:\s*"([^"]+)"/g;
  for (const m of html.matchAll(rivePkgRegex)) {
    const pkg = m[1];
    const ver = m[2];
    candidates.add(`https://unpkg.com/${pkg}@${ver}/rive.wasm`);
    candidates.add(`https://unpkg.com/${pkg}@${ver}/rive_fallback.wasm`);
    candidates.add(`https://cdn.jsdelivr.net/npm/${pkg}@${ver}/rive.wasm`);
    candidates.add(`https://cdn.jsdelivr.net/npm/${pkg}@${ver}/rive_fallback.wasm`);
  }

  // 8. Base URLs identificadas no próprio script JS para resolução de assets 3D/WASM
  const jsBaseRegex = /https?:\/\/[a-zA-Z0-9_\-\.]+(?:\/[a-zA-Z0-9_\-\.]+)*\/?/g;
  const jsBaseUrls = new Set<string>();
  if (baseUrl.includes('itsoffbrand.io') || baseUrl.includes('/gl') || baseUrl.includes('/rive') || baseUrl.includes('models') || baseUrl.includes('assets') || baseUrl.includes('static')) {
    try {
      jsBaseUrls.add(new URL('.', baseUrl).href);
      jsBaseUrls.add(new URL('../', baseUrl).href);
    } catch {}
  }
  for (const m of html.matchAll(jsBaseRegex)) {
    const u = m[0];
    if (u.includes('itsoffbrand.io') || u.includes('/gl') || u.includes('/rive') || u.includes('models') || u.includes('assets') || u.includes('static')) {
      jsBaseUrls.add(u.endsWith('/') ? u : u + '/');
    }
  }

  // 9. Arquivos 3D, WASM, HDR, Rive, JSON de fontes e texturas referenciados entre aspas em scripts JS
  const jsQuotedRegex = /["']([a-zA-Z0-9_\-\.\/]+\.(?:wasm|riv|glb|gltf|hdr|json|webp|png|jpg|jpeg|svg|gif|ico|avif|ktx2|basis))["']/g;
  for (const m of html.matchAll(jsQuotedRegex)) {
    const raw = m[1];
    if (!raw || raw.includes(' ') || raw.length > 200) continue;
    const cleanRel = raw.replace(/^\/+/, '');
    candidates.add(cleanRel);
    for (const b of jsBaseUrls) {
      try {
        candidates.add(new URL(cleanRel, b).href);
        if (!cleanRel.startsWith('gl/') && !b.includes('/gl')) {
          candidates.add(new URL(`gl/${cleanRel}`, b).href);
        }
      } catch {}
    }
  }

  // 10. Template literals dinâmicos em JS (ex: `/textures/head/${iQ}/diffuse.${iQ}`)
  const jsTemplateRegex = /`([^`]+)`/g;
  const commonFormats = ['webp', 'png', 'jpg', 'ktx2'];
  for (const m of html.matchAll(jsTemplateRegex)) {
    const tpl = m[1];
    if (
      tpl.includes('/textures/') ||
      tpl.includes('/gl/') ||
      tpl.includes('/models/') ||
      tpl.includes('/fonts/') ||
      tpl.includes('/rive/') ||
      tpl.includes('/assets/')
    ) {
      for (const fmt of commonFormats) {
        const expanded = tpl.replace(/\$\{[^}]+\}/g, fmt);
        const cleanRel = expanded.replace(/^\/+/, '');
        candidates.add(cleanRel);
        for (const b of jsBaseUrls) {
          try {
            candidates.add(new URL(cleanRel, b).href);
            if (!cleanRel.startsWith('gl/') && !b.includes('/gl')) {
              candidates.add(new URL(`gl/${cleanRel}`, b).href);
            }
          } catch {}
        }
      }
    }
  }

  // 11. Decoders especiais conhecidos em WebGL (Draco / Basis)
  if (html.includes('draco') || html.includes('dracoLoader') || html.includes('draco_decoder')) {
    for (const b of jsBaseUrls) {
      try {
        candidates.add(new URL('draco/draco_wasm_wrapper.js', b).href);
        candidates.add(new URL('draco/draco_decoder.wasm', b).href);
        candidates.add(new URL('draco_wasm_wrapper.js', b).href);
        candidates.add(new URL('draco_decoder.wasm', b).href);
      } catch {}
    }
  }

  const validUrls: string[] = [];
  for (const raw of candidates) {
    if (
      !raw ||
      raw.startsWith('data:') ||
      raw.startsWith('blob:') ||
      raw.startsWith('#') ||
      raw.startsWith('javascript:')
    ) {
      continue;
    }
    try {
      const fullUrl = new URL(raw, baseUrl).href;
      const parsed = new URL(fullUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        validUrls.push(fullUrl);
      }
    } catch {}
  }

  return [...new Set(validUrls)];
}

// Baixa concorrentemente recursos estáticos descobertos que não foram capturados pelo CDP
export async function downloadMissingStaticAssets(
  html: string,
  baseUrl: string,
  rootPageUrl: string,
  urlToZipMap: Map<string, string>,
  files: Record<string, Uint8Array>,
  limits?: { maxResources?: number; maxBytes?: number; currentTotalBytes?: number }
): Promise<{ addedBytes: number; addedCount: number; externalCount: number }> {
  const isRootLocal = isLocalhostPage(rootPageUrl);
  const maxRes = limits?.maxResources || MAX_CDP_RESOURCES;
  const maxB = limits?.maxBytes || MAX_CDP_BYTES;
  let currentBytes = limits?.currentTotalBytes || 0;

  let addedBytes = 0;
  let addedCount = 0;
  let externalCount = 0;

  const candidates = extractStaticAssetCandidates(html, baseUrl);

  const toFetch: { url: string; zipPath: string }[] = [];
  for (const candUrl of candidates) {
    const cleanCand = candUrl.split('?')[0];
    if (urlToZipMap.has(candUrl) || urlToZipMap.has(cleanCand)) {
      continue;
    }

    const check = validateUrl(candUrl, isRootLocal);
    if (!check.valid) continue;

    const zipPath = mapUrlToZipPath(candUrl, rootPageUrl);
    if (!zipPath) continue;

    if (files[zipPath]) {
      urlToZipMap.set(candUrl, zipPath);
      urlToZipMap.set(cleanCand, zipPath);
      continue;
    }

    toFetch.push({ url: candUrl, zipPath });
  }

  if (toFetch.length === 0) {
    return { addedBytes, addedCount, externalCount };
  }

  const CONCURRENCY = 12;
  const queue = [...toFetch];

  async function worker() {
    while (queue.length > 0) {
      if (Object.keys(files).length >= maxRes || currentBytes >= maxB) {
        break;
      }

      const item = queue.shift();
      if (!item) break;

      try {
        const resp = await fetch(item.url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) continue;

        // [SSRF Guard] Valida URL final após eventuais redirecionamentos
        if (resp.url) {
          const postCheck = validateUrl(resp.url, isRootLocal);
          if (!postCheck.valid) continue;
        }

        const buf = await resp.arrayBuffer();
        if (buf.byteLength === 0) continue;

        // [WASM Guard] Validação de integridade de arquivos WebAssembly
        if (item.zipPath.endsWith('.wasm')) {
          if (buf.byteLength < 8) {
            console.warn('[Faithful Engine] WASM vazio (< 8 bytes) rejeitado:', item.url);
            continue;
          }
          const checkUint = new Uint8Array(buf.slice(0, 4));
          // Magic bytes: 0x00, 0x61, 0x73, 0x6d ('\0asm')
          if (checkUint[0] !== 0x00 || checkUint[1] !== 0x61 || checkUint[2] !== 0x73 || checkUint[3] !== 0x6d) {
            console.warn('[Faithful Engine] WASM sem magic bytes 0061736d rejeitado:', item.url);
            continue;
          }
        }

        const uint = new Uint8Array(buf);
        files[item.zipPath] = uint;
        urlToZipMap.set(item.url, item.zipPath);
        urlToZipMap.set(item.url.split('?')[0], item.zipPath);

        // Se baixou rive.wasm ou rive_fallback.wasm, garante que o par correspondente exista no ZIP
        if (item.zipPath.endsWith('/rive.wasm') || item.zipPath === 'rive.wasm') {
          const fallbackZip = item.zipPath.replace(/rive\.wasm$/, 'rive_fallback.wasm');
          if (!files[fallbackZip]) {
            files[fallbackZip] = uint;
            urlToZipMap.set(item.url.replace(/rive\.wasm$/, 'rive_fallback.wasm'), fallbackZip);
          }
        } else if (item.zipPath.endsWith('/rive_fallback.wasm') || item.zipPath === 'rive_fallback.wasm') {
          const mainZip = item.zipPath.replace(/rive_fallback\.wasm$/, 'rive.wasm');
          if (!files[mainZip]) {
            files[mainZip] = uint;
            urlToZipMap.set(item.url.replace(/rive_fallback\.wasm$/, 'rive.wasm'), mainZip);
          }
        }

        addedBytes += uint.byteLength;
        currentBytes += uint.byteLength;
        addedCount++;

        if (item.zipPath.startsWith('_external/')) {
          externalCount++;
        }

        // Se for CSS, extrai recursivamente @import e url(...) para baixar fontes e imagens declaradas no CSS
        if (item.zipPath.endsWith('.css')) {
          try {
            const cssText = new TextDecoder().decode(buf);
            const nestedUrls = cssText.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi);
            for (const nu of nestedUrls) {
              const rawNu = nu[1];
              if (!rawNu || rawNu.startsWith('data:') || rawNu.startsWith('blob:') || rawNu.startsWith('#')) continue;
              try {
                const nestedFull = new URL(rawNu, item.url).href;
                const cleanNested = nestedFull.split('?')[0].split('#')[0];
                const decodedNested = decodeURIComponent(nestedFull);
                const decodedClean = decodeURIComponent(cleanNested);
                if (!urlToZipMap.has(nestedFull) && !urlToZipMap.has(cleanNested)) {
                  const checkNested = validateUrl(nestedFull, isRootLocal);
                  if (!checkNested.valid) continue;
                  const nestedZip = mapUrlToZipPath(nestedFull, rootPageUrl);
                  if (nestedZip && !files[nestedZip]) {
                    const nResp = await fetch(nestedFull, { signal: AbortSignal.timeout(8000) });
                    if (nResp.ok) {
                      if (nResp.url) {
                        const nPostCheck = validateUrl(nResp.url, isRootLocal);
                        if (!nPostCheck.valid) continue;
                      }
                      const nBuf = await nResp.arrayBuffer();
                      if (nBuf.byteLength > 0) {
                        const nUint = new Uint8Array(nBuf);
                        files[nestedZip] = nUint;
                        urlToZipMap.set(nestedFull, nestedZip);
                        urlToZipMap.set(cleanNested, nestedZip);
                        urlToZipMap.set(decodedNested, nestedZip);
                        urlToZipMap.set(decodedClean, nestedZip);
                        addedBytes += nUint.byteLength;
                        currentBytes += nUint.byteLength;
                        addedCount++;
                        if (nestedZip.startsWith('_external/')) externalCount++;
                      }
                    }
                  }
                }
              } catch {}
            }
          } catch {}
        }
      } catch {
        // Ignora falha de download individual
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return { addedBytes, addedCount, externalCount };
}
