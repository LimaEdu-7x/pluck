import type { ExtractionModule, ModuleContext, AnalyzeResult, RunResult } from '../types';
import { safePath } from '../../core/security/safe-path';
import { capturePageHtml } from '../../core/capture/capture-engine';

export const pageHtmlModule: ExtractionModule = {
  id: 'page-html',
  title: 'Somente HTML da página',
  description: 'Baixa unicamente o arquivo .html limpo.',
  badge: 'PADRÃO',

  async analyze(ctx: ModuleContext): Promise<AnalyzeResult> {
    const baseName = safePath(ctx.title || 'pagina');
    return {
      moduleId: 'page-html',
      totalItems: 1,
      items: [
        {
          name: `${baseName}.html`,
          type: 'text/html',
          sizeText: '1 arquivo HTML'
        }
      ],
      statusText: '1 arquivo HTML detectado · tamanho ao baixar'
    };
  },

  async run(ctx: ModuleContext): Promise<RunResult> {
    const capture = capturePageHtml({
      html: ctx.html || '',
      title: ctx.title || 'pagina',
      url: ctx.url || 'http://localhost',
      baseURI: ctx.url || 'http://localhost',
      stylesheets: [],
      images: []
    });

    if (ctx.onProgress) {
      ctx.onProgress(1, 1, capture.filename);
    }

    return {
      moduleId: 'page-html',
      filename: capture.filename,
      blob: capture.blob,
      mimeType: capture.mimeType,
      itemCount: 1,
      incomplete: false
    };
  }
};
