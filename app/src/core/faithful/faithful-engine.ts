// Orquestrador do Motor de Captura Fiel (CDP + Autoscroll + Reescrita + ZIP)

import { zipSync } from 'fflate';
import { FaithfulCaptureOptions, FaithfulCaptureResult, CapturedResource } from './types';
import { CdpNetworkRecorder, sanitizeUrlForStorage, MAX_CDP_RESOURCES, MAX_CDP_BYTES } from './cdp-recorder';
import { performAutoscroll } from './autoscroll';
import {
  mapUrlToZipPath,
  rewriteHtmlDocument,
  rewriteCssContent,
  rewriteJsContent
} from './rewriter';
import { createCrawlSession, extractCrawlLinks, enqueueDiscoveredLinks, recordDownloadedBytes } from './crawler';
import { generateReadmeText, generateAbrirBat, generateAbrirPs1, generateAbrirSh } from './opener-scripts';
import { safePath } from '../security/safe-path';
import { validateUrl, isLocalhostPage } from '../security/url-guard';
import { isValidDocumentHtml } from '../capture/capture-engine';

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

  try {
    // 1. Inicializa o Gravador CDP se houver tabId
    if (options.recorder) {
      recorder = options.recorder;
    } else if (tabId && typeof chrome !== 'undefined' && chrome.debugger) {
      recorder = new CdpNetworkRecorder(tabId);
      try {
        await recorder.start();
      } catch (cdpErr) {
        console.warn('Aviso: Não foi possível anexar chrome.debugger:', cdpErr);
        recorder = null;
      }
    }

    // 2. Executa autoscroll se habilitado
    if (autoscrollEnabled) {
      if (options.onProgress) {
        options.onProgress(0, 100, 'Executando autoscroll e ativando animações...');
      }

      if (tabId && typeof chrome !== 'undefined' && chrome.scripting) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: performAutoscroll,
            args: [{ step: 400, intervalMs: 150 }]
          });
        } catch {
          if (recorder) {
            try {
              await recorder.evaluate(`(${performAutoscroll.toString()})({ step: 400, intervalMs: 150 })`);
            } catch {}
          }
        }
      }
    }

    // 3. Captura o DOM serializado da página principal
    let mainHtml = options.html || '';
    if (!mainHtml && tabId && typeof chrome !== 'undefined' && chrome.scripting) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.documentElement.outerHTML
        });
        if (results && results[0]?.result) {
          mainHtml = results[0].result;
        }
      } catch (err) {
        console.warn('executeScript falhou no faithful-engine:', err);
      }
    }

    if (!mainHtml && recorder) {
      try {
        const cdpHtml = await recorder.evaluate('document.documentElement.outerHTML');
        if (cdpHtml) mainHtml = cdpHtml;
      } catch (err) {
        console.warn('CDP evaluate falhou no faithful-engine:', err);
      }
    }

    if (!isValidDocumentHtml(mainHtml)) {
      throw new Error(`Falha crítica no Modo Fiel: DOM da página principal vazio ou inacessível (${pageUrl}).`);
    }

    // 4. Coleta recursos gravados pelo CDP
    let capturedResources: CapturedResource[] = [];
    if (recorder) {
      if (options.onProgress) {
        options.onProgress(50, 100, 'Coletando recursos de rede via CDP...');
      }
      capturedResources = await recorder.collectResources((loaded, total, item) => {
        if (options.onProgress) {
          options.onProgress(loaded, total, item);
        }
      });
    }

    // 5. Mapeia todos os recursos capturados para caminhos dentro do ZIP
    for (const res of capturedResources) {
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

    // 6. Sessão de Crawler (se modo linked ou site)
    const crawlSession = createCrawlSession(pageUrl, options.limits);
    if (mode === 'linked' || mode === 'site') {
      const initialLinks = extractCrawlLinks(mainHtml, pageUrl, crawlSession);
      enqueueDiscoveredLinks(crawlSession, initialLinks, 0);

      const isRootLocal = isLocalhostPage(pageUrl);

      while (crawlSession.queuedUrls.length > 0 && !crawlSession.isFinished) {
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

        try {
          const res = await fetch(next.url);
          // [FIEL-03] Valida destino final após redirecionamento
          if (res.url) {
            const destCheck = validateUrl(res.url, isRootLocal);
            if (!destCheck.valid) {
              console.warn('[Crawler SSRF Guard] Redirecionamento bloqueado:', res.url);
              continue;
            }
          }

          if (res.ok) {
            const subHtml = await res.text();
            recordDownloadedBytes(crawlSession, subHtml.length);
            const subLinks = extractCrawlLinks(subHtml, next.url, crawlSession);
            enqueueDiscoveredLinks(crawlSession, subLinks, next.depth);

            // Reescreve e salva a subpágina
            const rewrittenSubHtml = rewriteHtmlDocument(subHtml, next.url, subPageZip, urlToZipMap);
            const encodedSub = new TextEncoder().encode(rewrittenSubHtml);
            files[subPageZip] = encodedSub;
            totalBytes += encodedSub.byteLength;
          }
        } catch {
          // Ignora subpágina inacessível
        }
      }
    }

    // 7. Processa e adiciona recursos ao ZIP
    for (const res of capturedResources) {
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

      files[zipPath] = dataBytes;
      totalBytes += dataBytes.byteLength;
    }

    // 8. Reescreve e salva a página HTML principal
    const rewrittenMainHtml = rewriteHtmlDocument(mainHtml, pageUrl, 'index.html', urlToZipMap);
    const mainHtmlBytes = new TextEncoder().encode(rewrittenMainHtml);
    files['index.html'] = mainHtmlBytes;
    totalBytes += mainHtmlBytes.byteLength;

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

    // 10. Gera o arquivo ZIP final
    const zipData = zipSync(files, { level: 6 });
    const blob = new Blob([zipData], { type: 'application/zip' });
    const cleanName = safePath(pageTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-'));

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
      files
    };
  } finally {
    if (recorder) {
      await recorder.stop().catch(() => {});
    }
  }
}
