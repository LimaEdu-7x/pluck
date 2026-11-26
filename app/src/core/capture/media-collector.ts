import { safePath } from '../security/safe-path';
import { ZipBuilder, DEFAULT_MEDIA_ZIP_LIMITS, type ZipLimits } from '../zip/zip-builder';
import { fetchResourceSafe, type CaptureResult, type CaptureStats } from './capture-engine';
import { isLocalhostPage } from '../security/url-guard';
import { sanitizeSvg, parseSrcset, extractCssUrls } from './image-collector';

export type MediaType = 'image' | 'video' | 'audio' | 'svg';

export interface MediaCandidate {
  url: string;
  type: MediaType;
  sourceKind: 'img' | 'video' | 'audio' | 'svg-inline' | 'css-url' | 'data-url';
  content?: string;
  preferredName?: string;
}

export interface MediaStats extends CaptureStats {
  skippedOversizedCount?: number;
  skippedByUserCount?: number;
  stoppedByUser?: boolean;
}

export interface MediaCaptureOptions {
  candidates: MediaCandidate[];
  title?: string;
  pageUrl?: string;
  types?: MediaType[];           // Tipos selecionados (padrão: todos ['image', 'video', 'audio', 'svg'])
  maxItems?: number;             // Padrão: 200 (Infinity para Sem limite)
  maxPerItemBytes?: number;      // Padrão: 50 MB (Infinity para Sem limite)
  foldersByType?: boolean;       // Padrão: true (pastas imagens/, videos/, audios/, vetores/)
  shouldSkipCurrent?: () => boolean; // Pular a mídia atual durante o download
  shouldStop?: () => boolean;    // Parar e salvar o que já foi baixado
  signal?: AbortSignal;          // AbortSignal para parada
  onProgress?: (current: number, total: number, currentItem?: string) => void;
}

/**
 * Coleta candidatos a mídias (imagens, vídeos, áudios e vetores SVG) presentes no DOM e templates.
 */
export function collectMediaFromDom(
  doc: Document,
  baseUrl: string = 'http://localhost',
  allowedTypes: MediaType[] = ['image', 'video', 'audio', 'svg']
): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  const seenUrls = new Set<string>();
  const typeSet = new Set<MediaType>(allowedTypes);

  function addCandidate(candidate: MediaCandidate) {
    if (!typeSet.has(candidate.type)) return;
    if (seenUrls.has(candidate.url)) return;
    seenUrls.add(candidate.url);
    candidates.push(candidate);
  }

  // 1. Imagens e SVGs via tags <img>
  const imgs = queryAllNodes<HTMLImageElement>(doc, 'img');
  imgs.forEach((img, idx) => {
    const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-thumb');
    if (src && !src.startsWith('javascript:')) {
      let resolved = src;
      try { resolved = new URL(src, baseUrl).href; } catch {}

      const isSvg = src.toLowerCase().includes('.svg') || src.startsWith('data:image/svg+xml');
      const medType: MediaType = isSvg ? 'svg' : 'image';

      let fileNameFromUrl = '';
      try {
        const u = new URL(resolved);
        const p = u.pathname.split('/').pop();
        if (p && p.includes('.')) fileNameFromUrl = decodeURIComponent(p);
      } catch {}

      addCandidate({
        url: resolved,
        type: medType,
        sourceKind: src.startsWith('data:') ? 'data-url' : 'img',
        preferredName: fileNameFromUrl || img.getAttribute('alt') || `imagem-${idx + 1}`
      });
    }

    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const parsed = parseSrcset(srcset, baseUrl);
      parsed.forEach((u, sIdx) => {
        const isSvg = u.toLowerCase().includes('.svg') || u.startsWith('data:image/svg+xml');
        addCandidate({
          url: u,
          type: isSvg ? 'svg' : 'image',
          sourceKind: u.startsWith('data:') ? 'data-url' : 'img',
          preferredName: `imagem-srcset-${idx + 1}-${sIdx + 1}`
        });
      });
    }
  });

  // 2. Picture <source>
  const sources = queryAllNodes<HTMLSourceElement>(doc, 'picture source');
  sources.forEach((srcEl, idx) => {
    const src = srcEl.getAttribute('src');
    if (src) {
      try {
        const resolved = new URL(src, baseUrl).href;
        const isSvg = src.toLowerCase().includes('.svg');
        addCandidate({
          url: resolved,
          type: isSvg ? 'svg' : 'image',
          sourceKind: 'img',
          preferredName: `picture-${idx + 1}`
        });
      } catch {}
    }
    const srcset = srcEl.getAttribute('srcset');
    if (srcset) {
      const parsed = parseSrcset(srcset, baseUrl);
      parsed.forEach((u, sIdx) => {
        const isSvg = u.toLowerCase().includes('.svg');
        addCandidate({
          url: u,
          type: isSvg ? 'svg' : 'image',
          sourceKind: 'img',
          preferredName: `picture-srcset-${idx + 1}-${sIdx + 1}`
        });
      });
    }
  });

  // 3. Vídeos (<video src="..."> e <video><source src="..."></video>)
  if (typeSet.has('video')) {
    const videos = queryAllNodes<HTMLVideoElement>(doc, 'video');
    videos.forEach((video, idx) => {
      const vSrc = video.getAttribute('src');
      if (vSrc) {
        try {
          const resolved = new URL(vSrc, baseUrl).href;
          addCandidate({
            url: resolved,
            type: 'video',
            sourceKind: 'video',
            preferredName: video.getAttribute('title') || `video-${idx + 1}`
          });
        } catch {}
      }

      const vSources = video.querySelectorAll('source');
      vSources.forEach((s, sIdx) => {
        const sSrc = s.getAttribute('src');
        if (sSrc) {
          try {
            const resolved = new URL(sSrc, baseUrl).href;
            addCandidate({
              url: resolved,
              type: 'video',
              sourceKind: 'video',
              preferredName: `video-${idx + 1}-${sIdx + 1}`
            });
          } catch {}
        }
      });

      // Se houver poster, extrai como imagem se desejado
      const poster = video.getAttribute('poster');
      if (poster && typeSet.has('image')) {
        try {
          const resolved = new URL(poster, baseUrl).href;
          addCandidate({
            url: resolved,
            type: 'image',
            sourceKind: 'img',
            preferredName: `video-poster-${idx + 1}`
          });
        } catch {}
      }
    });
  }

  // 4. Áudios (<audio src="..."> e <audio><source src="..."></audio>)
  if (typeSet.has('audio')) {
    const audios = queryAllNodes<HTMLAudioElement>(doc, 'audio');
    audios.forEach((audio, idx) => {
      const aSrc = audio.getAttribute('src');
      if (aSrc) {
        try {
          const resolved = new URL(aSrc, baseUrl).href;
          addCandidate({
            url: resolved,
            type: 'audio',
            sourceKind: 'audio',
            preferredName: audio.getAttribute('title') || `audio-${idx + 1}`
          });
        } catch {}
      }

      const aSources = audio.querySelectorAll('source');
      aSources.forEach((s, sIdx) => {
        const sSrc = s.getAttribute('src');
        if (sSrc) {
          try {
            const resolved = new URL(sSrc, baseUrl).href;
            addCandidate({
              url: resolved,
              type: 'audio',
              sourceKind: 'audio',
              preferredName: `audio-${idx + 1}-${sIdx + 1}`
            });
          } catch {}
        }
      });
    });
  }

  // 5. SVGs inline
  if (typeSet.has('svg')) {
    const svgElements = queryAllNodes<SVGElement>(doc, 'svg');
    svgElements.forEach((svg, idx) => {
      const cleanedSvg = sanitizeSvg(svg.outerHTML);
      if (!cleanedSvg) return;

      const svgId = svg.getAttribute('id') || svg.getAttribute('aria-label') || `vetor-${idx + 1}`;
      addCandidate({
        url: `inline-svg://${svgId}`,
        type: 'svg',
        sourceKind: 'svg-inline',
        content: cleanedSvg,
        preferredName: `${svgId}.svg`
      });
    });
  }

  // 6. Imagens de background em style="..."
  if (typeSet.has('image')) {
    const styledElements = queryAllNodes<HTMLElement>(doc, '[style*="url("]');
    styledElements.forEach((el, idx) => {
      const styleText = el.getAttribute('style') || '';
      const extracted = extractCssUrls(styleText, baseUrl);
      extracted.forEach((u, uIdx) => {
        const isSvg = u.toLowerCase().includes('.svg');
        addCandidate({
          url: u,
          type: isSvg ? 'svg' : 'image',
          sourceKind: 'css-url',
          preferredName: `fundo-${idx + 1}-${uIdx + 1}`
        });
      });
    });
  }

  return candidates;
}

/**
 * Empacota mídias selecionadas em um arquivo ZIP organizado em pastas por tipo:
 * - imagens/
 * - videos/
 * - audios/
 * - vetores/
 *
 * Respeita limites de quantidade, tamanho individual (pula acima do teto),
 * e permite parar ou pular a mídia atual.
 */
export async function captureMediaZip(options: MediaCaptureOptions): Promise<CaptureResult> {
  const {
    candidates,
    title = 'midias',
    pageUrl = '',
    types = ['image', 'video', 'audio', 'svg'],
    maxItems = 200,
    maxPerItemBytes = 50 * 1024 * 1024, // 50 MB padrão SPEC-v12
    foldersByType = true,
    shouldSkipCurrent,
    shouldStop,
    signal,
    onProgress
  } = options;

  const allowedTypesSet = new Set<MediaType>(types);

  // Filtra candidatos pelos tipos permitidos
  const filteredCandidates = candidates.filter((c) => allowedTypesSet.has(c.type));

  // Aplica teto de quantidade se não for "Sem limite"
  const itemLimit = maxItems && maxItems > 0 && maxItems !== Infinity ? maxItems : filteredCandidates.length;
  const queue = filteredCandidates.slice(0, itemLimit);

  const stats: MediaStats = {
    totalAssets: queue.length,
    savedAssets: 0,
    corsBlockedAssets: 0,
    failedAssets: 0,
    skippedOversizedCount: 0,
    skippedByUserCount: 0,
    stoppedByUser: false
  };

  const customLimits: ZipLimits = {
    maxFiles: maxItems === Infinity || !maxItems ? 10000 : maxItems + 50,
    maxTotalBytes: DEFAULT_MEDIA_ZIP_LIMITS.maxTotalBytes,
    maxPerFileBytes: maxPerItemBytes === Infinity ? 1024 * 1024 * 1024 : (maxPerItemBytes || DEFAULT_MEDIA_ZIP_LIMITS.maxPerFileBytes)
  };

  const zip = new ZipBuilder(customLimits);
  const usedFilenames = new Set<string>();
  const allowLocalhost = isLocalhostPage(pageUrl);

  const typeFolders: Record<MediaType, string> = {
    image: 'imagens',
    video: 'videos',
    audio: 'audios',
    svg: 'vetores'
  };

  function getUniqueZipPath(mediaType: MediaType, base: string, ext: string): string {
    const safeBase = safePath(base);
    const folder = foldersByType ? `${typeFolders[mediaType]}/` : '';
    let candidate = `${folder}${safeBase}${ext}`;
    let counter = 1;
    while (usedFilenames.has(candidate.toLowerCase())) {
      candidate = `${folder}${safeBase}-${counter}${ext}`;
      counter++;
    }
    usedFilenames.add(candidate.toLowerCase());
    return candidate;
  }

  let index = 0;
  for (const item of queue) {
    index++;

    // Verifica parada geral pelo usuário ("Parar e salvar")
    if ((shouldStop && shouldStop()) || signal?.aborted) {
      stats.stoppedByUser = true;
      break;
    }

    // Verifica se o usuário pediu para pular esta mídia ("Pular a mídia atual")
    if (shouldSkipCurrent && shouldSkipCurrent()) {
      stats.skippedByUserCount = (stats.skippedByUserCount || 0) + 1;
      continue;
    }

    if (onProgress) {
      onProgress(index, queue.length, item.preferredName || `midia-${index}`);
    }

    // Caso 1: SVG Inline
    if (item.sourceKind === 'svg-inline' && item.content) {
      const sanitized = sanitizeSvg(item.content);
      const zipPath = getUniqueZipPath('svg', item.preferredName?.replace(/\.svg$/i, '') || `vetor-${index}`, '.svg');
      const added = zip.addFile(zipPath, sanitized);
      if (added) {
        stats.savedAssets++;
      } else {
        stats.failedAssets++;
      }
      continue;
    }

    // Caso 2: URL Remota ou Data URL
    const fetched = await fetchResourceSafe(item.url, 20000, allowLocalhost);

    // Checa novamente cancelamento após fetch
    if ((shouldStop && shouldStop()) || signal?.aborted) {
      stats.stoppedByUser = true;
      break;
    }

    if (fetched && fetched.data.length > 0) {
      // Checa tamanho máximo por mídia: pula acima do limite (SPEC-v12)
      if (maxPerItemBytes !== Infinity && fetched.data.length > maxPerItemBytes) {
        stats.skippedOversizedCount = (stats.skippedOversizedCount || 0) + 1;
        continue;
      }

      let ext = '.bin';
      const mime = fetched.mimeType.toLowerCase();

      if (item.type === 'svg' || mime.includes('svg')) ext = '.svg';
      else if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
      else if (mime.includes('png')) ext = '.png';
      else if (mime.includes('webp')) ext = '.webp';
      else if (mime.includes('gif')) ext = '.gif';
      else if (mime.includes('avif')) ext = '.avif';
      else if (mime.includes('mp4')) ext = '.mp4';
      else if (mime.includes('webm')) ext = '.webm';
      else if (mime.includes('quicktime')) ext = '.mov';
      else if (mime.includes('ogg') && item.type === 'video') ext = '.ogv';
      else if (mime.includes('mp3') || mime.includes('mpeg')) ext = '.mp3';
      else if (mime.includes('wav')) ext = '.wav';
      else if (mime.includes('ogg') || mime.includes('opus')) ext = '.ogg';
      else if (mime.includes('aac') || mime.includes('m4a')) ext = '.m4a';
      else {
        try {
          const u = new URL(item.url);
          const dotIdx = u.pathname.lastIndexOf('.');
          if (dotIdx !== -1 && u.pathname.length - dotIdx <= 5) {
            ext = u.pathname.substring(dotIdx);
          }
        } catch {}
      }

      let dataToSave: Uint8Array = fetched.data;
      if (item.type === 'svg' || ext === '.svg' || mime.includes('svg')) {
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

      let baseName = item.preferredName || `midia-${index}`;
      if (baseName.includes('.')) {
        baseName = baseName.substring(0, baseName.lastIndexOf('.'));
      }

      const zipPath = getUniqueZipPath(item.type, baseName, ext);
      const added = zip.addFile(zipPath, dataToSave);
      if (added) {
        stats.savedAssets++;
      } else {
        stats.failedAssets++;
      }
    } else {
      stats.corsBlockedAssets++;
    }
  }

  const zipResult = zip.build();
  const baseName = safePath(title || 'midias');
  const filename = `${baseName}-midias.zip`;
  const blob = new Blob([zipResult.data.buffer as ArrayBuffer], { type: 'application/zip' });

  return {
    filename,
    blob,
    mimeType: 'application/zip',
    stats,
    sanitizedHtml: ''
  };
}

function queryAllNodes<T extends Element = Element>(
  root: Document | DocumentFragment | Element,
  selector: string
): T[] {
  const result: T[] = Array.from(root.querySelectorAll<T>(selector));
  const templates = root.querySelectorAll('template');
  for (let i = 0; i < templates.length; i++) {
    const tmpl = templates[i] as HTMLTemplateElement;
    if (tmpl.content) {
      result.push(...queryAllNodes<T>(tmpl.content, selector));
    }
  }
  return result;
}
