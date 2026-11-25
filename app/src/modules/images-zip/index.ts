import type { ExtractionModule, ModuleContext, AnalyzeResult, RunResult, AnalyzeItem } from '../types';
import { safePath } from '../../core/security/safe-path';
import { collectImagesFromDom, captureImagesZip, type ImageCandidate } from '../../core/capture/image-collector';

export const imagesZipModule: ExtractionModule = {
  id: 'images-zip',
  title: 'Somente imagens em ZIP',
  description: 'Extrai todas as imagens renderizadas no DOM.',
  badge: 'GALERIA',

  async analyze(ctx: ModuleContext): Promise<AnalyzeResult> {
    const items: AnalyzeItem[] = [];

    if (ctx.resources && ctx.resources.length > 0) {
      const imgResources = ctx.resources.filter((r) => r.type === 'image');
      for (const img of imgResources) {
        items.push({
          name: safePath(img.url.split('/').pop() || 'image'),
          type: 'image'
        });
      }
    } else if (typeof DOMParser !== 'undefined' && ctx.html) {
      const doc = new DOMParser().parseFromString(ctx.html, 'text/html');
      const candidates = collectImagesFromDom(doc, ctx.url || 'http://localhost');
      for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i];
        items.push({
          name: item.preferredName || `imagem-${i + 1}`,
          type: item.type === 'svg-inline' ? 'image/svg+xml' : 'image'
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
    const candidates: ImageCandidate[] = [];

    if (ctx.resources && ctx.resources.length > 0) {
      // Recursos pré-carregados (suporte a fixtures de teste)
      const imgResources = ctx.resources.filter((r) => r.type === 'image');
      for (let i = 0; i < imgResources.length; i++) {
        const res = imgResources[i];
        if (res.data) {
          const rawName = res.url.split('/').pop() || `imagem-${i + 1}.png`;
          candidates.push({
            url: res.url,
            type: 'image',
            preferredName: safePath(rawName)
          });
        }
      }
    } else if (typeof DOMParser !== 'undefined' && ctx.html) {
      const doc = new DOMParser().parseFromString(ctx.html, 'text/html');
      const fromDom = collectImagesFromDom(doc, ctx.url || 'http://localhost');
      candidates.push(...fromDom);
    }

    const capture = await captureImagesZip({
      candidates,
      title: ctx.title || 'imagens',
      pageUrl: ctx.url || '',
      onProgress: ctx.onProgress
    });

    return {
      moduleId: 'images-zip',
      filename: capture.filename,
      blob: capture.blob,
      mimeType: capture.mimeType,
      itemCount: capture.stats.savedAssets,
      incomplete: capture.stats.corsBlockedAssets > 0 || capture.stats.failedAssets > 0
    };
  }
};
