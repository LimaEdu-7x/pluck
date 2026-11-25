import type { ExtractionModule, ModuleContext, AnalyzeResult, RunResult } from '../types';
import { safePath } from '../../core/security/safe-path';
import { capturePageHtml } from '../../core/capture/capture-engine';

export const pageHtmlModule: ExtractionModule = {
  id: 'page-html',
  title: 'HTML autossuficiente',
  description: 'Arquivo único (.html) com estilos e imagens embutidos em data: URI.',
  badge: 'ARQUIVO ÚNICO',

  async analyze(ctx: ModuleContext): Promise<AnalyzeResult> {
    const baseName = safePath(ctx.title || 'pagina');
    return {
      moduleId: 'page-html',
      totalItems: 1,
      items: [
        {
          name: `${baseName}.html`,
          type: 'text/html',
          sizeText: '1 arquivo HTML autossuficiente'
        }
      ],
      statusText: '1 arquivo HTML autossuficiente detectado · tamanho ao baixar'
    };
  },

  async run(ctx: ModuleContext): Promise<RunResult> {
    const capture = await capturePageHtml({
      html: ctx.html || '',
      title: ctx.title || 'pagina',
      url: ctx.url || 'http://localhost',
      baseURI: ctx.url || 'http://localhost',
      stylesheets: [],
      images: []
    }, ctx.onProgress);

    return {
      moduleId: 'page-html',
      filename: capture.filename,
      blob: capture.blob,
      mimeType: capture.mimeType,
      itemCount: 1,
      incomplete: (capture.stats.omittedAssets?.count || 0) > 0
    };
  }
};
