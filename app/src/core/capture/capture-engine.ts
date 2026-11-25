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
}

export interface CaptureResult {
  filename: string;
  blob: Blob;
  mimeType: string;
  stats: CaptureStats;
  sanitizedHtml: string;
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
 * Executa o modo page-html:
 * Apenas o .html higienizado, sem ZIP, sem assets externos.
 */
export function capturePageHtml(data: PageRawData): CaptureResult {
  const sanitized = sanitizeHtml(data.html || '<!DOCTYPE html><html><head></head><body></body></html>');
  const baseName = safePath(data.title || 'pagina');
  const filename = `${baseName}.html`;
  const blob = new Blob([sanitized], { type: 'text/html;charset=utf-8' });

  return {
    filename,
    blob,
    mimeType: 'text/html',
    stats: {
      totalAssets: 0,
      savedAssets: 0,
      corsBlockedAssets: 0,
      failedAssets: 0
    },
    sanitizedHtml: sanitized
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
  const stats: CaptureStats = {
    totalAssets: 0,
    savedAssets: 0,
    corsBlockedAssets: 0,
    failedAssets: 0
  };

  // 1. Sanitiza o HTML base primeiro
  const baseSanitized = sanitizeHtml(data.html || '<!DOCTYPE html><html><head></head><body></body></html>');

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
