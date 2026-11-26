import { sanitizeHtml } from '../sanitizer';
import { safePath } from '../security/safe-path';
import { ZipBuilder, DEFAULT_PAGE_ZIP_LIMITS } from '../zip/zip-builder';
import { validateUrl, isLocalhostPage } from '../security/url-guard';
import { sanitizeSvg } from './image-collector';

export interface PageRawData {
  html: string;
  title: string;
  url: string;
  baseURI: string;
  stylesheets: string[];
  images: string[];
}

export interface ResourceFetchResult {
  url: string;
  localPath: string;
  data: Uint8Array;
  mimeType: string;
}

export interface CaptureStats {
  totalAssets: number;
  savedAssets: number;
  corsBlockedAssets: number;
  failedAssets: number;
  omittedAssets?: {
    count: number;
    totalBytes: number;
    reasons: string[];
  };
  inlinedStyles?: number;
  inlinedImages?: number;
  inlinedFonts?: number;
}

export const MAX_SINGLE_FILE_ASSET_BYTES = 2 * 1024 * 1024; // 2 MB por recurso
export const MAX_SINGLE_FILE_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB total do HTML autossuficiente

export interface CaptureResult {
  filename: string;
  blob: Blob;
  mimeType: string;
  stats: CaptureStats;
  sanitizedHtml: string;
}

/**
 * Valida se uma string contém estrutura HTML mínima de um documento web real.
 * Rejeita strings vazias, documentos sem <html> e payloads truncados.
 */
export function isValidDocumentHtml(html: string | undefined | null): boolean {
  if (!html || typeof html !== 'string') return false;
  const trimmed = html.trim();
  if (trimmed.length < 50) return false;
  const lower = trimmed.toLowerCase();
  return lower.includes('<html') && (lower.includes('<body') || lower.includes('<head'));
}

/**
 * Faz fetch seguro de um recurso respeitando CORS.
 * Se falhar por CORS ou rede, retorna null sem lançar erro.
 */
export async function fetchResourceSafe(
  url: string,
  timeoutMs = 15000,
  allowLocalhost = false
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  // Ignora esquemas inseguros ou vazios
  if (!url || url.startsWith('javascript:') || url.startsWith('about:')) {
    return null;
  }

  // Data URLs são decodificadas localmente
  if (url.startsWith('data:')) {
    try {
      const commaIdx = url.indexOf(',');
      if (commaIdx === -1) return null;
      const meta = url.substring(5, commaIdx);
      const isBase64 = meta.includes('base64');
      const rawData = url.substring(commaIdx + 1);
      const mimeType = meta.split(';')[0] || 'application/octet-stream';

      if (isBase64) {
        const binStr = atob(rawData);
        const u8 = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) {
          u8[i] = binStr.charCodeAt(i);
        }
        return { data: u8, mimeType };
      } else {
        const decoded = decodeURIComponent(rawData);
        const encoder = new TextEncoder();
        return { data: encoder.encode(decoded), mimeType };
      }
    } catch {
      return null;
    }
  }

  // [SEC-04] Todo fetch passa por validação com url-guard prevenindo SSRF
  const validation = validateUrl(url, allowLocalhost);
  if (!validation.valid) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      return null;
    }

    // [SSRF Defense-in-depth] Valida a URL final pós-redirecionamento HTTP (ex: 302 para IP privado)
    if (res.url && res.url !== url) {
      const redirectCheck = validateUrl(res.url, allowLocalhost);
      if (!redirectCheck.valid) {
        return null;
      }
    }

    const buf = await res.arrayBuffer();
    const mimeType = res.headers.get('content-type') || 'application/octet-stream';
    return { data: new Uint8Array(buf), mimeType };
  } catch {
    // CORS bloqueado, timeout ou erro de rede -> trata com elegância
    return null;
  }
}

/**
 * Converte Uint8Array para base64 em blocos para evitar overflow de stack em buffers grandes.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 16384;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

function inferMimeFromUrl(url: string, typeHint: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.woff2')) return 'font/woff2';
    if (pathname.endsWith('.woff')) return 'font/woff';
    if (pathname.endsWith('.ttf')) return 'font/ttf';
    if (pathname.endsWith('.otf')) return 'font/otf';
    if (pathname.endsWith('.eot')) return 'application/vnd.ms-fontobject';
    if (pathname.endsWith('.svg')) return 'image/svg+xml';
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.avif')) return 'image/avif';
    if (pathname.endsWith('.ico')) return 'image/x-icon';
    if (pathname.endsWith('.css')) return 'text/css';
  } catch {}
  return typeHint === 'font' ? 'font/woff2' : (typeHint === 'css' ? 'text/css' : 'image/png');
}

/**
 * Executa o modo page-html (HTML autossuficiente):
 * Gera UM arquivo .html único: CSS (link e @import) inline em <style>,
 * imagens/fontes/background url() embutidos como data: URI (base64).
 * Tetos aplicados: até 2 MB por recurso e 25 MB total no arquivo HTML.
 * O que exceder os limites fica de fora e é reportado nas estatísticas.
 * Scripts e rastreadores removidos com sanitizer e CSP segura offline.
 */
export async function capturePageHtml(
  data: PageRawData,
  onProgress?: (loaded: number, total: number, currentItem?: string) => void
): Promise<CaptureResult> {
  if (!isValidDocumentHtml(data.html)) {
    throw new Error('Conteúdo HTML da página vazio ou insuficiente para captura (mínimo de 50 caracteres com estrutura <html> válida).');
  }

  // 1. Sanitiza estrutura base (remove scripts, senhas, nonces, etc.)
  const baseSanitized = sanitizeHtml(data.html, {
    removeScripts: true,
    removeHiddenInputs: true,
    removePasswordInputs: true,
    removeNonces: true,
    injectCsp: false // Injetamos a CSP especializada com data: e unsafe-inline abaixo
  });

  const parser = new DOMParser();
  const doc = parser.parseFromString(baseSanitized, 'text/html');

  // Prevenção de requisições externas desnecessárias no HTML offline
  const preloads = doc.querySelectorAll(
    'link[rel="preload"], link[rel="prefetch"], link[rel="prerender"], link[rel="dns-prefetch"], link[rel="preconnect"]'
  );
  preloads.forEach((el) => el.remove());

  const allowLocalhost = isLocalhostPage(data.url || data.baseURI || '');
  let currentTotalBytes = new TextEncoder().encode(baseSanitized).length;
  let inlinedStylesCount = 0;
  let inlinedImagesCount = 0;
  let inlinedFontsCount = 0;
  let corsBlockedCount = 0;
  let omittedCount = 0;
  let omittedBytes = 0;
  const omittedReasons: string[] = [];

  // Cache para reutilizar recursos repetidos sem re-downloads
  const assetCache = new Map<string, { dataUrl: string | null; size: number; reason?: string }>();

  async function getAssetDataUrl(url: string, typeHint: 'image' | 'font' | 'css'): Promise<string | null> {
    if (!url || url.startsWith('javascript:') || url.startsWith('about:')) {
      return null;
    }

    if (url.startsWith('data:')) {
      const len = url.length;
      if (len > MAX_SINGLE_FILE_ASSET_BYTES) {
        omittedCount++;
        omittedBytes += len;
        omittedReasons.push(`Data URI excedeu teto de 2 MB (${Math.round(len / 1024)} KB)`);
        return null;
      }
      return url;
    }

    if (assetCache.has(url)) {
      const cached = assetCache.get(url)!;
      return cached.dataUrl;
    }

    const validation = validateUrl(url, allowLocalhost);
    if (!validation.valid) {
      omittedCount++;
      omittedReasons.push(`URL bloqueada por segurança (${validation.reason || 'inválida'}): ${url}`);
      assetCache.set(url, { dataUrl: null, size: 0, reason: 'security' });
      return null;
    }

    const fetched = await fetchResourceSafe(url, 15000, allowLocalhost);
    if (!fetched || !fetched.data || fetched.data.length === 0) {
      corsBlockedCount++;
      omittedCount++;
      omittedReasons.push(`Falha de rede ou CORS: ${url}`);
      assetCache.set(url, { dataUrl: null, size: 0, reason: 'network_fail' });
      return null;
    }

    const size = fetched.data.length;
    if (size > MAX_SINGLE_FILE_ASSET_BYTES) {
      omittedCount++;
      omittedBytes += size;
      omittedReasons.push(`Recurso excedeu limite de 2 MB (${(size / (1024 * 1024)).toFixed(1)} MB): ${url}`);
      assetCache.set(url, { dataUrl: null, size, reason: 'exceeded_cap' });
      return null;
    }

    // Estimativa de expansão em base64
    const base64Len = Math.ceil(size / 3) * 4;
    if (currentTotalBytes + base64Len > MAX_SINGLE_FILE_TOTAL_BYTES) {
      omittedCount++;
      omittedBytes += size;
      omittedReasons.push(`Teto total de 25 MB do HTML atingido. Omitido: ${url}`);
      assetCache.set(url, { dataUrl: null, size, reason: 'total_cap' });
      return null;
    }

    let mime = fetched.mimeType.split(';')[0].trim();
    if (!mime || mime === 'application/octet-stream') {
      mime = inferMimeFromUrl(url, typeHint);
    }

    let dataBytes = fetched.data;
    if (mime.includes('svg')) {
      try {
        const rawSvg = new TextDecoder().decode(fetched.data);
        const cleaned = sanitizeSvg(rawSvg);
        if (cleaned) {
          dataBytes = new TextEncoder().encode(cleaned);
        }
      } catch {}
    }

    const b64 = uint8ArrayToBase64(dataBytes);
    const dataUrl = `data:${mime};base64,${b64}`;
    currentTotalBytes += dataUrl.length;

    if (typeHint === 'image') inlinedImagesCount++;
    else if (typeHint === 'font') inlinedFontsCount++;

    assetCache.set(url, { dataUrl, size });
    return dataUrl;
  }

  async function inlineCssUrls(
    cssText: string,
    cssBaseUrl: string,
    visitedImports = new Set<string>()
  ): Promise<string> {
    const importRegex = /@import\s+(?:url\(['"]?([^'"()]+)['"]?\)|['"]([^'"]+)['"])([^;]*);/gi;
    let match: RegExpExecArray | null;
    const importReplacements: { fullMatch: string; replacement: string }[] = [];

    while ((match = importRegex.exec(cssText)) !== null) {
      const fullMatch = match[0];
      const importUrlRaw = (match[1] || match[2] || '').trim();
      const media = (match[3] || '').trim();

      if (!importUrlRaw || visitedImports.has(importUrlRaw)) {
        importReplacements.push({ fullMatch, replacement: '' });
        continue;
      }

      try {
        const fullImportUrl = new URL(importUrlRaw, cssBaseUrl).href;
        if (visitedImports.has(fullImportUrl)) {
          importReplacements.push({ fullMatch, replacement: '' });
          continue;
        }
        visitedImports.add(fullImportUrl);

        const fetched = await fetchResourceSafe(fullImportUrl, 15000, isLocalhostPage(fullImportUrl));
        if (fetched && fetched.data.length > 0) {
          const importedCssText = new TextDecoder().decode(fetched.data);
          const processedImported = await inlineCssUrls(importedCssText, fullImportUrl, visitedImports);
          const wrapped = media ? `@media ${media} {\n${processedImported}\n}` : processedImported;
          importReplacements.push({ fullMatch, replacement: wrapped });
        } else {
          importReplacements.push({ fullMatch, replacement: `/* Falha ao importar CSS: ${importUrlRaw} */` });
        }
      } catch {
        importReplacements.push({ fullMatch, replacement: '' });
      }
    }

    let resolvedCss = cssText;
    for (const { fullMatch, replacement } of importReplacements) {
      resolvedCss = resolvedCss.replace(fullMatch, replacement);
    }

    const urlRegex = /url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi;
    const urlReplacements: { fullMatch: string; replacement: string }[] = [];
    const processedUrls = new Set<string>();

    while ((match = urlRegex.exec(resolvedCss)) !== null) {
      const fullMatch = match[0];
      if (processedUrls.has(fullMatch)) continue;
      processedUrls.add(fullMatch);

      const rawTarget = match[2].trim();
      if (!rawTarget || rawTarget.startsWith('#')) {
        continue;
      }

      let fullTargetUrl = rawTarget;
      if (!rawTarget.startsWith('data:')) {
        try {
          fullTargetUrl = new URL(rawTarget, cssBaseUrl).href;
        } catch {
          continue;
        }
      }

      const lowerTarget = fullTargetUrl.toLowerCase();
      const isFont =
        lowerTarget.includes('.woff2') ||
        lowerTarget.includes('.woff') ||
        lowerTarget.includes('.ttf') ||
        lowerTarget.includes('.otf') ||
        lowerTarget.includes('.eot');
      const typeHint = isFont ? 'font' : 'image';

      // SPEC-v12: no modo Só HTML, imagens no CSS mantêm a URL remota absoluta do site online
      if (!isFont) {
        urlReplacements.push({ fullMatch, replacement: `url("${fullTargetUrl}")` });
        continue;
      }

      const dataUrl = await getAssetDataUrl(fullTargetUrl, typeHint);
      if (dataUrl) {
        urlReplacements.push({ fullMatch, replacement: `url("${dataUrl}")` });
      } else {
        urlReplacements.push({ fullMatch, replacement: `url("${fullTargetUrl}")` });
      }
    }

    for (const { fullMatch, replacement } of urlReplacements) {
      resolvedCss = resolvedCss.split(fullMatch).join(replacement);
    }

    return resolvedCss;
  }

  // 1. Processa <link rel="stylesheet">
  const linkElements = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
  const totalSteps = linkElements.length + (doc.images ? doc.images.length : 0);
  let step = 0;

  for (const link of linkElements) {
    step++;
    const rawHref = link.getAttribute('href');
    if (!rawHref) continue;

    if (onProgress) {
      onProgress(step, totalSteps, `Estilo: ${rawHref.split('/').pop() || rawHref}`);
    }

    try {
      const fullUrl = new URL(rawHref, data.baseURI).href;
      const fetched = await fetchResourceSafe(fullUrl, 15000, allowLocalhost);
      if (fetched && fetched.data.length > 0) {
        if (fetched.data.length > MAX_SINGLE_FILE_ASSET_BYTES) {
          omittedCount++;
          omittedBytes += fetched.data.length;
          omittedReasons.push(`CSS externo excedeu limite de 2 MB (${(fetched.data.length / (1024 * 1024)).toFixed(1)} MB): ${fullUrl}`);
          link.remove();
          continue;
        }
        const rawCss = new TextDecoder().decode(fetched.data);
        const processedCss = await inlineCssUrls(rawCss, fullUrl);
        const styleEl = doc.createElement('style');
        styleEl.setAttribute('data-inlined-from', rawHref);
        styleEl.textContent = processedCss;
        link.replaceWith(styleEl);
        inlinedStylesCount++;
      } else {
        corsBlockedCount++;
        omittedCount++;
        omittedReasons.push(`CSS externo inacessível: ${fullUrl}`);
        link.remove();
      }
    } catch {
      link.remove();
    }
  }

  // 2. Processa tags <style> já existentes
  const styleElements = Array.from(doc.querySelectorAll('style'));
  for (const styleEl of styleElements) {
    const rawCss = styleEl.textContent || '';
    if (rawCss.includes('url(') || rawCss.includes('@import')) {
      const processed = await inlineCssUrls(rawCss, data.baseURI);
      styleEl.textContent = processed;
    }
  }

  // 3. Processa elementos com atributo style="..."
  const inlineStyled = Array.from(doc.querySelectorAll('[style]'));
  for (const el of inlineStyled) {
    const raw = el.getAttribute('style') || '';
    if (raw.includes('url(')) {
      const processed = await inlineCssUrls(raw, data.baseURI);
      el.setAttribute('style', processed);
    }
  }

  // 4. Processa tags <img> (SPEC-v12: imagens apontam direto para a URL absoluta do site online)
  const imgElements = Array.from(doc.querySelectorAll('img')) as HTMLImageElement[];
  for (const img of imgElements) {
    step++;
    let rawSrc = img.getAttribute('src');
    const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-thumb');
    if ((!rawSrc || rawSrc.startsWith('data:image/gif') || rawSrc.length < 50) && dataSrc) {
      rawSrc = dataSrc;
    }

    const rawSrcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');

    if (onProgress) {
      onProgress(step, totalSteps, `Imagem: ${(rawSrc || '').split('/').pop() || 'img'}`);
    }

    let absoluteUrl: string | null = null;
    if (rawSrc && !rawSrc.startsWith('javascript:')) {
      if (rawSrc.startsWith('data:')) {
        absoluteUrl = rawSrc;
      } else {
        try {
          absoluteUrl = new URL(rawSrc, data.baseURI).href;
        } catch {}
      }
    }

    if (absoluteUrl) {
      img.setAttribute('src', absoluteUrl);
      inlinedImagesCount++;
    }

    if (rawSrcset) {
      const candidates = rawSrcset.split(',').map((s) => s.trim()).filter(Boolean);
      const absCandidates: string[] = [];
      for (const cand of candidates) {
        const parts = cand.split(/\s+/);
        const cUrl = parts[0];
        const descriptor = parts.slice(1).join(' ');
        if (cUrl.startsWith('data:')) {
          absCandidates.push(cand);
        } else {
          try {
            const abs = new URL(cUrl, data.baseURI).href;
            absCandidates.push(descriptor ? `${abs} ${descriptor}` : abs);
          } catch {
            absCandidates.push(cand);
          }
        }
      }
      if (absCandidates.length > 0) {
        img.setAttribute('srcset', absCandidates.join(', '));
      }
    }

    img.removeAttribute('data-src');
    img.removeAttribute('data-srcset');
    img.removeAttribute('data-original');
    img.removeAttribute('data-thumb');
    img.setAttribute('loading', 'eager');
  }

  // 5. Processa <source> (em <picture> e <video>): URLs absolutas remotas
  const sourceElements = Array.from(doc.querySelectorAll('source')) as HTMLSourceElement[];
  for (const srcEl of sourceElements) {
    const rawSrcset = srcEl.getAttribute('srcset');
    if (rawSrcset) {
      const candidates = rawSrcset.split(',').map((s) => s.trim()).filter(Boolean);
      const absCandidates: string[] = [];
      for (const cand of candidates) {
        const parts = cand.split(/\s+/);
        const cUrl = parts[0];
        const descriptor = parts.slice(1).join(' ');
        if (cUrl.startsWith('data:')) {
          absCandidates.push(cand);
        } else {
          try {
            const abs = new URL(cUrl, data.baseURI).href;
            absCandidates.push(descriptor ? `${abs} ${descriptor}` : abs);
          } catch {
            absCandidates.push(cand);
          }
        }
      }
      if (absCandidates.length > 0) {
        srcEl.setAttribute('srcset', absCandidates.join(', '));
      }
    }
    const rawSrc = srcEl.getAttribute('src');
    if (rawSrc && !rawSrc.startsWith('data:') && !rawSrc.startsWith('javascript:')) {
      try {
        srcEl.setAttribute('src', new URL(rawSrc, data.baseURI).href);
      } catch {}
    }
  }

  // 6. Previne tela em branco de preloaders/overlays sem script e revela elementos com animações travadas
  const animatedEls = doc.querySelectorAll(
    '[data-reveal], [data-choreo], [data-draw-rule], [data-draw-tick], [data-draw-eyebrow], [data-reveal-group], [data-w-id]'
  );
  animatedEls.forEach((el) => {
    const raw = el.getAttribute('style') || '';
    if (raw.includes('opacity:') || raw.includes('visibility:') || raw.includes('filter:')) {
      const fixed = raw
        .replace(/opacity:\s*0[^;]*;?/gi, 'opacity: 1;')
        .replace(/visibility:\s*hidden[^;]*;?/gi, 'visibility: visible;')
        .replace(/filter:\s*blur\([^)]+\)[^;]*;?/gi, 'filter: none;')
        .replace(/transform:\s*translate\([^)]+\)[^;]*;?/gi, 'transform: none;')
        .replace(/transform:\s*scale\(0[^)]*\)[^;]*;?/gi, 'transform: scale(1, 1);');
      el.setAttribute('style', fixed);
    }
  });

  const bypassStyle = doc.createElement('style');
  bypassStyle.textContent = `
    .transition-w, .preloader, [class*="preloader"], [id*="preloader"], .high-line-reveal {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .gl-wrap {
      z-index: 0 !important;
    }
    section.is-otot-home {
      background-color: #f4f4ed !important;
      color: #3b3c38 !important;
    }
    [data-reveal], [data-choreo], [data-draw-rule], [data-draw-tick], [data-draw-eyebrow], [data-reveal-group] {
      opacity: 1 !important;
      visibility: visible !important;
      filter: none !important;
      transform: none !important;
    }
  `;
  if (doc.head) {
    doc.head.appendChild(bypassStyle);
  }

  // 7. Injeta CSP estrita offline para arquivo único (img/font/media remotas e data:, style unsafe-inline)
  let head = doc.head;
  if (!head) {
    head = doc.createElement('head');
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
  }
  const existingCsps = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]');
  existingCsps.forEach((c) => c.remove());

  const metaCsp = doc.createElement('meta');
  metaCsp.setAttribute('http-equiv', 'Content-Security-Policy');
  metaCsp.setAttribute(
    'content',
    "default-src 'none'; img-src https: http: data:; font-src https: http: data:; style-src 'unsafe-inline'; media-src https: http: data:; base-uri 'none'; form-action 'none'"
  );
  head.insertBefore(metaCsp, head.firstChild);

  // 8. Serializa o HTML final autossuficiente
  const finalHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  const baseName = safePath(data.title || 'pagina');
  const filename = `${baseName}.html`;
  const blob = new Blob([finalHtml], { type: 'text/html;charset=utf-8' });

  const totalAssetsCount = inlinedStylesCount + inlinedImagesCount + inlinedFontsCount + omittedCount;
  const savedAssetsCount = inlinedStylesCount + inlinedImagesCount + inlinedFontsCount;

  return {
    filename,
    blob,
    mimeType: 'text/html',
    stats: {
      totalAssets: totalAssetsCount,
      savedAssets: savedAssetsCount,
      corsBlockedAssets: corsBlockedCount,
      failedAssets: omittedCount,
      omittedAssets: {
        count: omittedCount,
        totalBytes: omittedBytes,
        reasons: omittedReasons
      },
      inlinedStyles: inlinedStylesCount,
      inlinedImages: inlinedImagesCount,
      inlinedFonts: inlinedFontsCount
    },
    sanitizedHtml: finalHtml
  };
}

/**
 * Executa o modo page-zip:
 * HTML higienizado + CSS + imagens + fontes em ZIP com fflate.
 * Recursos com falha de CORS são ignorados e computados nas estatísticas.
 */
export async function capturePageZip(
  data: PageRawData,
  onProgress?: (loaded: number, total: number, currentItem?: string) => void
): Promise<CaptureResult> {
  if (!isValidDocumentHtml(data.html)) {
    throw new Error('Conteúdo HTML da página vazio ou insuficiente para captura (mínimo de 50 caracteres com estrutura <html> válida).');
  }
  const stats: CaptureStats = {
    totalAssets: 0,
    savedAssets: 0,
    corsBlockedAssets: 0,
    failedAssets: 0
  };

  // 1. Sanitiza o HTML base primeiro
  const baseSanitized = sanitizeHtml(data.html);

  // 2. Faz o parse do HTML higienizado no DOM da UI
  const parser = new DOMParser();
  const doc = parser.parseFromString(baseSanitized, 'text/html');

  // Coleta URLs únicas a partir do documento limpo
  const assetMap = new Map<string, string>(); // url original -> caminho local relativo
  const zip = new ZipBuilder(DEFAULT_PAGE_ZIP_LIMITS);

  const linkElements = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
  const imgElements = Array.from(doc.querySelectorAll('img')) as HTMLImageElement[];

  const allUrls: { url: string; element: Element; attr: string; prefix: string }[] = [];

  linkElements.forEach((el, i) => {
    const rawHref = el.getAttribute('href');
    if (rawHref && !rawHref.startsWith('data:') && !rawHref.startsWith('javascript:')) {
      const fullUrl = new URL(rawHref, data.baseURI).href;
      allUrls.push({ url: fullUrl, element: el, attr: 'href', prefix: `style-${i + 1}` });
    }
  });

  imgElements.forEach((el, i) => {
    const rawSrc = el.getAttribute('src');
    if (rawSrc && !rawSrc.startsWith('data:') && !rawSrc.startsWith('javascript:')) {
      const fullUrl = new URL(rawSrc, data.baseURI).href;
      allUrls.push({ url: fullUrl, element: el, attr: 'src', prefix: `image-${i + 1}` });
    }
  });

  stats.totalAssets = allUrls.length;

  let loadedCount = 0;
  // [NOVO-02] Determina allowLocalhost EXCLUSIVAMENTE pelo hostname da URL da página da aba
  const allowLocalhost = isLocalhostPage(data.url || data.baseURI || '');

  for (const item of allUrls) {
    if (assetMap.has(item.url)) {
      item.element.setAttribute(item.attr, assetMap.get(item.url)!);
      loadedCount++;
      if (onProgress) {
        onProgress(loadedCount, stats.totalAssets, item.prefix);
      }
      continue;
    }

    const fetched = await fetchResourceSafe(item.url, 15000, allowLocalhost);

    if (fetched && fetched.data.length > 0) {
      let ext = item.prefix.startsWith('style') ? '.css' : '.png';
      try {
        const u = new URL(item.url);
        const pathname = u.pathname;
        const lastSlash = pathname.lastIndexOf('.');
        if (lastSlash !== -1 && pathname.length - lastSlash <= 5) {
          ext = pathname.substring(lastSlash);
        }
      } catch {}

      // [SEC-02 / NOVO-03] SVGs remotos ou embutidos no page-zip passam por sanitizeSvg
      let dataToSave = fetched.data;
      if (ext === '.svg' || fetched.mimeType.toLowerCase().includes('svg')) {
        try {
          const rawSvgText = new TextDecoder().decode(fetched.data);
          const cleaned = sanitizeSvg(rawSvgText);
          if (cleaned) {
            dataToSave = new TextEncoder().encode(cleaned);
          } else {
            stats.failedAssets++;
            continue;
          }
        } catch {
          stats.failedAssets++;
          continue;
        }
      }

      const cleanFileName = safePath(`${item.prefix}${ext}`);
      const relativeZipPath = `assets/${cleanFileName}`;

      const added = zip.addFile(relativeZipPath, dataToSave);
      if (added) {
        assetMap.set(item.url, relativeZipPath);
        item.element.setAttribute(item.attr, relativeZipPath);
        stats.savedAssets++;
      } else {
        stats.failedAssets++;
      }
    } else {
      // Falha de CORS ou rede: ignora e conta!
      stats.corsBlockedAssets++;
    }

    loadedCount++;
    if (onProgress) {
      onProgress(loadedCount, stats.totalAssets, item.prefix);
    }
  }

  // 3. Serializa o HTML reescrito final
  const finalHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  zip.addFile('index.html', finalHtml);

  // 4. Constrói o pacote ZIP
  const zipResult = zip.build();
  const baseName = safePath(data.title || 'pagina');
  const filename = `${baseName}.zip`;
  const blob = new Blob([zipResult.data.buffer as ArrayBuffer], { type: 'application/zip' });

  return {
    filename,
    blob,
    mimeType: 'application/zip',
    stats,
    sanitizedHtml: finalHtml
  };
}
