import type { ExtractionModule, ModuleContext, AnalyzeResult, RunResult, AnalyzeItem } from '../types';
import { safePath } from '../../core/security/safe-path';
import { capturePageZip } from '../../core/capture/capture-engine';
import { ZipBuilder, DEFAULT_PAGE_ZIP_LIMITS } from '../../core/zip/zip-builder';
import { sanitizeHtml } from '../../core/sanitizer';

export const pageZipModule: ExtractionModule = {
  id: 'page-zip',
  title: 'Página completa em ZIP',
  description: 'HTML limpo, estilos CSS, fontes e imagens.',
  badge: 'COMPLETO',

  async analyze(ctx: ModuleContext): Promise<AnalyzeResult> {
    const items: AnalyzeItem[] = [
      { name: 'index.html', type: 'text/html' }
    ];

    if (ctx.resources && ctx.resources.length > 0) {
      for (const res of ctx.resources) {
        items.push({
          name: safePath(res.url.split('/').pop() || 'resource'),
          type: res.type
        });
      }
    } else if (typeof DOMParser !== 'undefined' && ctx.html) {
      const doc = new DOMParser().parseFromString(ctx.html, 'text/html');
      const links = doc.querySelectorAll('link[rel="stylesheet"]');
      const imgs = doc.querySelectorAll('img');
      items.push(...Array.from(links).map((_l, i) => ({
        name: `style-${i + 1}.css`,
        type: 'stylesheet'
      })));
      items.push(...Array.from(imgs).map((_img, i) => ({
        name: `image-${i + 1}.png`,
        type: 'image'
      })));
    }

    return {
      moduleId: 'page-zip',
      totalItems: items.length,
      items,
      statusText: `${items.length} itens detectados · tamanho ao baixar`
    };
  },

  async run(ctx: ModuleContext): Promise<RunResult> {
    // Se resources pré-carregados forem fornecidos (ex: testes unitários offline)
    if (ctx.resources && ctx.resources.length > 0) {
      const sanitizedHtml = sanitizeHtml(ctx.html || '<!DOCTYPE html><html><head></head><body></body></html>');
      const zip = new ZipBuilder(DEFAULT_PAGE_ZIP_LIMITS);
      zip.addFile('index.html', sanitizedHtml);

      for (const res of ctx.resources) {
        if (res.data) {
          const fileName = safePath(res.url.split('/').pop() || 'asset');
          zip.addFile(`assets/${fileName}`, res.data);
        }
      }

      const zipResult = zip.build();
      const baseName = safePath(ctx.title || 'pagina');
      const filename = `${baseName}.zip`;
      const blob = new Blob([zipResult.data.buffer as ArrayBuffer], { type: 'application/zip' });

      return {
        moduleId: 'page-zip',
        filename,
        blob,
        mimeType: 'application/zip',
        itemCount: zipResult.fileCount,
        incomplete: zipResult.incomplete
      };
    }

    // Fluxo normal com captura dinâmica de assets e tratamento de CORS
    const capture = await capturePageZip({
      html: ctx.html || '',
      title: ctx.title || 'pagina',
      url: ctx.url || 'http://localhost',
      baseURI: ctx.url || 'http://localhost',
      stylesheets: [],
      images: []
    }, ctx.onProgress);

    return {
      moduleId: 'page-zip',
      filename: capture.filename,
      blob: capture.blob,
      mimeType: capture.mimeType,
      itemCount: capture.stats.savedAssets + 1, // index.html + assets
      incomplete: capture.stats.corsBlockedAssets > 0 || capture.stats.failedAssets > 0
    };
  }
};
