import { safePath } from '../security/safe-path';
import { ZipBuilder, DEFAULT_IMAGES_ZIP_LIMITS } from '../zip/zip-builder';
import { fetchResourceSafe, type CaptureResult, type CaptureStats } from './capture-engine';
import { isLocalhostPage } from '../security/url-guard';

export interface ImageCandidate {
  url: string;
  type: 'image' | 'svg-inline' | 'data-url';
  content?: string; // Para svg inline
  preferredName?: string;
}

export interface ImagesCaptureOptions {
  candidates: ImageCandidate[];
  title?: string;
  pageUrl?: string; // [NOVO-02] URL da aba/página atual para aferição estrita de localhost
  onProgress?: (current: number, total: number, currentItem?: string) => void;
}

/**
 * Faz parse de strings srcset separando candidatos e resolvendo URLs.
 * Suporta descriptors (1x, 2x, 500w) e data URLs.
 */
export function parseSrcset(srcset: string, baseURI: string): string[] {
  if (!srcset || typeof srcset !== 'string') return [];

  const urls: string[] = [];
  // Divide por vírgulas que não estejam dentro de data:image
  const entries = srcset.split(/,\s+(?![^,]*base64)/);

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // O primeiro token antes do espaço é a URL (o resto é descriptor como 2x ou 640w)
    const rawUrl = trimmed.split(/\s+/)[0];
    if (!rawUrl) continue;

    if (rawUrl.startsWith('data:')) {
      urls.push(rawUrl);
    } else {
      try {
        const resolved = new URL(rawUrl, baseURI).href;
        urls.push(resolved);
      } catch {
        // URL inválida, ignora
      }
    }
  }

  return urls;
}

/**
 * Extrai URLs de declarações CSS contendo url(...)
 */
export function extractCssUrls(cssText: string, baseURI: string): string[] {
  if (!cssText || typeof cssText !== 'string') return [];

  const urls: string[] = [];
  const urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(cssText)) !== null) {
    const rawUrl = match[1]?.trim();
    if (!rawUrl || rawUrl.startsWith('javascript:')) continue;

    if (rawUrl.startsWith('data:')) {
      urls.push(rawUrl);
    } else {
      try {
        const resolved = new URL(rawUrl, baseURI).href;
        urls.push(resolved);
      } catch {}
    }
  }

  return urls;
}

/**
 * [SEC-02] Sanitiza SVGs inline removendo scripts, elementos SMIL maliciosos e event handlers.
 */
export function sanitizeSvg(rawSvg: string): string {
  if (!rawSvg || typeof rawSvg !== 'string') return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(rawSvg, 'image/svg+xml');

  // Remove scripts e elementos de execução externa/HTML incorporado
  const dangerous = doc.querySelectorAll('script, foreignObject, animate, set, handler');
  dangerous.forEach((el) => el.remove());

  // Remove handlers on*, links javascript: e referências externas (href/xlink:href)
  const allElements = doc.querySelectorAll('*');
  allElements.forEach((el) => {
    const toRemove: string[] = [];
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i];
      const name = attr.name.toLowerCase();
      const val = attr.value.replace(/[\x00-\x20\s]/g, '').toLowerCase();

      if (name.startsWith('on')) {
        toRemove.push(attr.name);
      } else if (name === 'href' || name === 'xlink:href' || name.endsWith(':href')) {
        // [SEC-02] Permite estritamente referências locais de fragmento (#id); bloqueia javascript, dados e URLs externas
        if (!val.startsWith('#')) {
          toRemove.push(attr.name);
        }
      }
    }
    toRemove.forEach((attrName) => el.removeAttribute(attrName));
  });

  const rootSvg = doc.querySelector('svg');
  if (!rootSvg) return '';

  if (!rootSvg.getAttribute('xmlns')) {
    rootSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  return new XMLSerializer().serializeToString(rootSvg);
}

/**
 * Coleta todas as imagens do documento DOM:
 * img (src, currentSrc, srcset), picture/source, CSS background-image e SVG inline.
 */
export function collectImagesFromDom(doc: Document, baseURI: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seenUrls = new Set<string>();

  function addUrl(url: string, preferredName?: string) {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);

    if (url.startsWith('data:')) {
      candidates.push({ url, type: 'data-url', preferredName });
    } else {
      candidates.push({ url, type: 'image', preferredName });
    }
  }

  function getPreferredNameFromUrl(rawUrl: string, fallback: string): string {
    try {
      const u = new URL(rawUrl, baseURI);
      const last = u.pathname.split('/').pop();
      if (last && last.includes('.')) {
        return last;
      }
    } catch {}
    return fallback;
  }

  // 1. Tags <img>
  const imgElements = doc.querySelectorAll('img');
  imgElements.forEach((img, idx) => {
    const src = img.getAttribute('src');
    if (src) {
      try {
        const full = new URL(src, baseURI).href;
        addUrl(full, getPreferredNameFromUrl(src, `imagem-${idx + 1}`));
      } catch {}
    }

    const currentSrc = (img as HTMLImageElement).currentSrc;
    if (currentSrc && currentSrc !== src) {
      try {
        const full = new URL(currentSrc, baseURI).href;
        addUrl(full, getPreferredNameFromUrl(currentSrc, `imagem-${idx + 1}-current`));
      } catch {}
    }

    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const srcsetUrls = parseSrcset(srcset, baseURI);
      srcsetUrls.forEach((u, sIdx) => addUrl(u, getPreferredNameFromUrl(u, `imagem-${idx + 1}-srcset-${sIdx + 1}`)));
    }
  });

  // 2. Tags <picture> com <source srcset="...">
  const sourceElements = doc.querySelectorAll('picture source[srcset]');
  sourceElements.forEach((source, idx) => {
    const srcset = source.getAttribute('srcset');
    if (srcset) {
      const srcsetUrls = parseSrcset(srcset, baseURI);
      srcsetUrls.forEach((u, sIdx) => addUrl(u, getPreferredNameFromUrl(u, `picture-source-${idx + 1}-${sIdx + 1}`)));
    }
  });

  // 3. Inline style com background-image ou background
  const styledElements = doc.querySelectorAll('[style*="background"]');
  styledElements.forEach((el, idx) => {
    const styleAttr = el.getAttribute('style') || '';
    const bgUrls = extractCssUrls(styleAttr, baseURI);
    bgUrls.forEach((u, bIdx) => addUrl(u, getPreferredNameFromUrl(u, `background-${idx + 1}-${bIdx + 1}`)));
  });

  // 4. Tags <svg> inline
  const svgElements = doc.querySelectorAll('svg');
  svgElements.forEach((svg, idx) => {
    const cleanedSvg = sanitizeSvg(svg.outerHTML);
    if (!cleanedSvg) return;

    const svgId = svg.getAttribute('id') || svg.getAttribute('aria-label') || `vetor-${idx + 1}`;
    candidates.push({
      url: `inline-svg://${svgId}`,
      type: 'svg-inline',
      content: cleanedSvg,
      preferredName: `${svgId}.svg`
    });
  });

  return candidates;
}

/**
 * Empacota todas as imagens coletadas em um arquivo ZIP com fflate.
 * Tolerância a CORS: recursos que falharem no fetch são ignorados e computados nas estatísticas.
 * Formatos nativos preservados (SEM conversão para WebP).
 */
export async function captureImagesZip(options: ImagesCaptureOptions): Promise<CaptureResult> {
  const { candidates, title = 'imagens', pageUrl = '', onProgress } = options;

  const stats: CaptureStats = {
    totalAssets: candidates.length,
    savedAssets: 0,
    corsBlockedAssets: 0,
    failedAssets: 0
  };

  const zip = new ZipBuilder(DEFAULT_IMAGES_ZIP_LIMITS);
  const usedFilenames = new Set<string>();

  // [NOVO-02] Localhost só é permitido se o hostname da página da aba for legítimo localhost
  const allowLocalhost = isLocalhostPage(pageUrl);

  function getUniqueFilename(base: string, ext: string): string {
    const safeBase = safePath(base);
    let candidate = `${safeBase}${ext}`;
    let counter = 1;
    while (usedFilenames.has(candidate.toLowerCase())) {
      candidate = `${safeBase}-${counter}${ext}`;
      counter++;
    }
    usedFilenames.add(candidate.toLowerCase());
    return candidate;
  }

  let index = 0;
  for (const item of candidates) {
    index++;
    if (onProgress) {
      onProgress(index, candidates.length, item.preferredName || `imagem-${index}`);
    }

    // Caso 1: SVG Inline
    if (item.type === 'svg-inline' && item.content) {
      const sanitized = sanitizeSvg(item.content);
      const fileName = getUniqueFilename(item.preferredName?.replace(/\.svg$/i, '') || `vetor-${index}`, '.svg');
      const added = zip.addFile(fileName, sanitized);
      if (added) {
        stats.savedAssets++;
      } else {
        stats.failedAssets++;
      }
      continue;
    }

    // Caso 2: Data URL ou URL remota
    const fetched = await fetchResourceSafe(item.url, 15000, allowLocalhost);

    if (fetched && fetched.data.length > 0) {
      let ext = '.png'; // default

      // Determina extensão a partir do MIME type nativo ou pathname da URL
      const mime = fetched.mimeType.toLowerCase();
      if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
      else if (mime.includes('png')) ext = '.png';
      else if (mime.includes('webp')) ext = '.webp';
      else if (mime.includes('svg')) ext = '.svg';
      else if (mime.includes('gif')) ext = '.gif';
      else if (mime.includes('avif')) ext = '.avif';
      else if (mime.includes('icon') || mime.includes('ico')) ext = '.ico';
      else {
        try {
          const u = new URL(item.url);
          const pathname = u.pathname;
          const dotIdx = pathname.lastIndexOf('.');
          if (dotIdx !== -1 && pathname.length - dotIdx <= 5) {
            ext = pathname.substring(dotIdx);
          }
        } catch {}
      }

      // [SEC-02 / NOVO-03] SVGs via data: URLs ou download remoto DEVEM ser sanitizados antes de entrar no ZIP
      let dataToSave: Uint8Array = fetched.data;
      if (ext === '.svg' || mime.includes('svg')) {
        try {
          const rawSvgText = new TextDecoder().decode(fetched.data);
          const cleaned = sanitizeSvg(rawSvgText);
          if (!cleaned) {
            stats.failedAssets++;
            continue;
          }
          dataToSave = new TextEncoder().encode(cleaned);
        } catch {
          stats.failedAssets++;
          continue;
        }
      }

      // Deriva nome base
      let baseName = item.preferredName || `imagem-${index}`;
      if (baseName.includes('.')) {
        baseName = baseName.substring(0, baseName.lastIndexOf('.'));
      }

      if (!item.preferredName && !item.url.startsWith('data:')) {
        try {
          const u = new URL(item.url);
          const rawLast = u.pathname.split('/').pop();
          if (rawLast) {
            const dot = rawLast.lastIndexOf('.');
            baseName = dot !== -1 ? rawLast.substring(0, dot) : rawLast;
          }
        } catch {}
      }

      const finalFileName = getUniqueFilename(baseName, ext);
      const added = zip.addFile(finalFileName, dataToSave);
      if (added) {
        stats.savedAssets++;
      } else {
        stats.failedAssets++;
      }
    } else {
      // Falha de CORS ou rede -> ignora e conta!
      stats.corsBlockedAssets++;
    }
  }

  const zipResult = zip.build();
  const baseName = safePath(title || 'imagens');
  const filename = `${baseName}-imagens.zip`;
  const blob = new Blob([zipResult.data.buffer as ArrayBuffer], { type: 'application/zip' });

  return {
    filename,
    blob,
    mimeType: 'application/zip',
    stats,
    sanitizedHtml: ''
  };
}
