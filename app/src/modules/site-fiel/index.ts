import { ExtractionModule, ModuleContext, AnalyzeResult, RunResult } from '../types';
import { captureFaithfulSite } from '../../core/faithful/faithful-engine';

export const siteFielModule: ExtractionModule = {
  id: 'site-fiel',
  title: 'Clone Fiel',
  description: 'Cópia completa com autoscroll, gravação CDP de rede e suporte offline.',
  badge: 'FIEL',

  async analyze(ctx: ModuleContext): Promise<AnalyzeResult> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(ctx.html || '<!DOCTYPE html><html><body></body></html>', 'text/html');

    const scriptsCount = doc.querySelectorAll('script').length;
    const stylesheetsCount = doc.querySelectorAll('link[rel="stylesheet"]').length;
    const imagesCount = doc.querySelectorAll('img, picture, svg').length;
    const totalEst = 1 + scriptsCount + stylesheetsCount + imagesCount;

    return {
      moduleId: 'site-fiel',
      totalItems: totalEst,
      items: [
        { name: 'Documento HTML principal', type: 'html', sizeText: '1 arquivo' },
        { name: 'Folhas de estilo (CSS)', type: 'css', sizeText: `${stylesheetsCount} arquivos` },
        { name: 'Scripts do framework (JS)', type: 'js', sizeText: `${scriptsCount} arquivos` },
        { name: 'Imagens e mídias', type: 'image', sizeText: `${imagesCount} arquivos` }
      ],
      statusText: `${totalEst} elementos mapeados para cópia fiel`
    };
  },

  async run(ctx: ModuleContext): Promise<RunResult> {
    const result = await captureFaithfulSite({
      tabId: ctx.tabId,
      url: ctx.url,
      title: ctx.title,
      html: ctx.html,
      mode: 'page',
      autoscroll: true,
      onProgress: (loaded, total, item) => {
        if (ctx.onProgress) {
          ctx.onProgress(loaded, total, item);
        }
      }
    });

    return {
      moduleId: 'site-fiel',
      filename: result.filename,
      blob: result.blob,
      mimeType: 'application/zip',
      itemCount: result.stats.totalAssets
    };
  }
};
