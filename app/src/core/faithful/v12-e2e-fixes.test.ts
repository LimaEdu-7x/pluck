import { describe, it, expect, vi } from 'vitest';
import { capturePageHtml } from '../capture/capture-engine';
import { imagesZipModule } from '../../modules/images-zip';
import { performAutoscroll } from './autoscroll';
import { unzipSync } from 'fflate';

describe('Validação Real das 3 Correções E2E da SPEC v12', () => {
  // --------------------------------------------------------------------------
  // ITEM 1: SÓ HTML LEVE COM IMAGENS REMOTAS E SEM SCRIPTS
  // --------------------------------------------------------------------------
  it('Item 1 (Só HTML): gera HTML leve com imagens apontando para https://, sem base64 e sem scripts', async () => {
    let imgsHtml = '';
    for (let i = 1; i <= 20; i++) {
      imgsHtml += `<div class="card"><img src="https://getartcraft.com/assets/img/preview-${i}.png" alt="Card ${i}"></div>\n`;
    }

    const rawPayload = {
      html: `<!DOCTYPE html><html><head><title>ArtCraft Preview</title><style>body { background: #fff; }</style><script>console.log('evil')</script></head><body><h1>ArtCraft</h1>${imgsHtml}</body></html>`,
      title: 'ArtCraft Preview',
      url: 'https://getartcraft.com/',
      baseURI: 'https://getartcraft.com/',
      stylesheets: [],
      images: []
    };

    const result = await capturePageHtml(rawPayload);
    const htmlSize = result.blob.size;
    const htmlContent = result.sanitizedHtml;

    const countScript = (htmlContent.match(/<script/gi) || []).length;
    const countRemoteImgs = (htmlContent.match(/src="https:\/\/getartcraft\.com\/assets\/img\/preview-\d+\.png"/g) || []).length;
    const countBase64Imgs = (htmlContent.match(/src="data:image/gi) || []).length;

    // Tamanho leve (muito inferior aos 7.1 MB reportados pelo Radar)
    expect(htmlSize).toBeLessThan(100 * 1024); // < 100 KB
    // Imagens remotas preservadas
    expect(countRemoteImgs).toBe(20);
    // Zero imagens embutidas em base64
    expect(countBase64Imgs).toBe(0);
    // Zero scripts
    expect(countScript).toBe(0);
  });

  // --------------------------------------------------------------------------
  // ITEM 2: SOMENTE MÍDIAS (PASTAS /imagens, /vetores, sem HTML de site)
  // --------------------------------------------------------------------------
  it('Item 2 (Somente mídias): gera ZIP com pastas /imagens e /vetores, sem HTML ou scripts de site', async () => {
    let mediaHtml = `<!DOCTYPE html><html><head><title>Galeria</title></head><body>`;
    for (let i = 1; i <= 5; i++) {
      mediaHtml += `<img src="https://example.com/foto-${i}.jpg" alt="Foto ${i}">\n`;
    }
    mediaHtml += `<svg id="icone-check"><circle cx="10" cy="10" r="8"/></svg>\n`;
    mediaHtml += `</body></html>`;

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string) => {
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer
      };
    });

    const mediaResult = await imagesZipModule.run({
      title: 'ArtCraft',
      url: 'https://getartcraft.com',
      html: mediaHtml
    });
    globalThis.fetch = origFetch;

    const zipBuffer = new Uint8Array(await mediaResult.blob.arrayBuffer());
    const unzipped = unzipSync(zipBuffer);
    const zipFiles = Object.keys(unzipped);

    // Contém pastas de mídias por tipo
    const hasImagesFolder = zipFiles.some((f) => f.startsWith('imagens/'));
    const hasVetoresFolder = zipFiles.some((f) => f.startsWith('vetores/'));
    expect(hasImagesFolder).toBe(true);
    expect(hasVetoresFolder).toBe(true);

    // NÃO contém index.html, abrir.bat, abrir.ps1 (não baixa site inteiro)
    const hasSiteHtml = zipFiles.some((f) => f.endsWith('.html') || f.includes('abrir.'));
    expect(hasSiteHtml).toBe(false);
  });

  // --------------------------------------------------------------------------
  // ITEM 3: ROLAGEM INFINITA POR TEMPO (Honra a duração configurada)
  // --------------------------------------------------------------------------
  it('Item 3 (Rolagem por tempo): honra a duração configurada mesmo em página de altura fixa', async () => {
    const targetDurationSeconds = 1; // 1 segundo no teste para rapidez
    const scrollStart = Date.now();

    const scrollResult = await performAutoscroll({
      step: 400,
      intervalMs: 30,
      initialHeight: 1500, // Altura percorrível em ~120ms
      limitType: 'time',
      maxTimeSeconds: targetDurationSeconds
    });

    const scrollDurationMs = Date.now() - scrollStart;

    // Garante que não parou precocemente nos primeiros ~120ms quando bateu na altura da página
    expect(scrollDurationMs).toBeGreaterThanOrEqual(950);
    expect(scrollResult.totalScrolled).toBeGreaterThanOrEqual(1500);
  });
});
