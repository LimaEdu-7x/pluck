import type { ExtractionModule, ModuleContext, AnalyzeResult, RunResult, AnalyzeItem } from '../types';
import { safePath } from '../../core/security/safe-path';
import {
  collectMediaFromDom,
  captureMediaZip,
  type MediaCandidate
} from '../../core/capture/media-collector';

export const imagesZipModule: ExtractionModule = {
  id: 'images-zip',
  title: 'Somente imagens em ZIP',
  description: 'Extrai imagens, vetores SVG, vídeos e áudios em pastas por tipo.',
  badge: 'GALERIA',

  async analyze(ctx: ModuleContext): Promise<AnalyzeResult> {
    const items: AnalyzeItem[] = [];

    if (ctx.resources && ctx.resources.length > 0) {
      const imgResources = ctx.resources.filter((r) => r.type === 'image' || (r.type as string) === 'media');
      for (const img of imgResources) {
        items.push({
          name: safePath(img.url.split('/').pop() || 'media'),
          type: 'image'
        });
      }
    } else if (typeof DOMParser !== 'undefined' && ctx.html) {
      const doc = new DOMParser().parseFromString(ctx.html, 'text/html');
      const candidates = collectMediaFromDom(doc, ctx.url || 'http://localhost');
      for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i];
        items.push({
          name: item.preferredName || `midia-${i + 1}`,
          type: item.type === 'svg' ? 'image/svg+xml' : item.type
        });
      }
    }

    return {
      moduleId: 'images-zip',
      totalItems: items.length,
      items,
      statusText: `${items.length} imagens detectadas · tamanho ao baixar`
    };
  },

  async run(ctx: ModuleContext): Promise<RunResult> {
    const candidates: MediaCandidate[] = [];

    if (ctx.resources && ctx.resources.length > 0) {
      // Recursos pré-carregados (suporte a fixtures de teste)
      const imgResources = ctx.resources.filter((r) => r.type === 'image' || (r.type as string) === 'media');
      for (let i = 0; i < imgResources.length; i++) {
        const res = imgResources[i];
        if (res.data) {
          const rawName = res.url.split('/').pop() || `imagem-${i + 1}.png`;
          candidates.push({
            url: res.url,
            type: 'image',
            sourceKind: 'img',
            preferredName: safePath(rawName)
          });
        }
      }
    } else if (typeof DOMParser !== 'undefined' && ctx.html) {
      const doc = new DOMParser().parseFromString(ctx.html, 'text/html');
      const fromDom = collectMediaFromDom(doc, ctx.url || 'http://localhost');
      candidates.push(...fromDom);
    }

    const capture = await captureMediaZip({
      candidates,
      title: ctx.title || 'imagens',
      pageUrl: ctx.url || '',
      foldersByType: true,
      onProgress: ctx.onProgress
    });

    return {
      moduleId: 'images-zip',
      filename: `${safePath(ctx.title || 'imagens')}-imagens.zip`,
      blob: capture.blob,
      mimeType: capture.mimeType,
      itemCount: capture.stats.savedAssets,
      incomplete: capture.stats.corsBlockedAssets > 0 || capture.stats.failedAssets > 0
    };
  }
};
