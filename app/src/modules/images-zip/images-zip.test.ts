import { describe, it, expect, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { imagesZipModule } from './index';
import { sanitizeSvg } from '../../core/capture/image-collector';

describe('images-zip Module', () => {
  it('possui metadados corretos', () => {
    expect(imagesZipModule.id).toBe('images-zip');
    expect(imagesZipModule.badge).toBe('GALERIA');
    expect(imagesZipModule.title).toBe('Somente imagens em ZIP');
  });

  it('analisa imagens na página incluindo svg, srcset e background', async () => {
    const html = `
      <html>
        <body style="background-image: url('fundo.jpg');">
          <img src="banner.jpg" srcset="banner-2x.jpg 2x">
          <svg id="icone-check"><path d="M0 0"/></svg>
        </body>
      </html>
    `;

    const analysis = await imagesZipModule.analyze({
      url: 'https://example.com',
      title: 'Galeria',
      html
    });

    expect(analysis.totalItems).toBeGreaterThanOrEqual(3);
    expect(analysis.statusText).toContain('imagens detectadas');
  });

  it('executa extração empacotando apenas imagens em ZIP com formatos nativos', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('logo.png')) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'image/png' }),
          arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
        };
      }
      return { ok: false };
    });

    const html = `
      <html>
        <body>
          <img src="https://example.com/logo.png">
          <svg id="vetor-1"><circle cx="5" cy="5" r="5"/></svg>
        </body>
      </html>
    `;

    const progressCalls: any[] = [];
    const result = await imagesZipModule.run({
      url: 'https://example.com',
      title: 'Fotos',
      html,
      onProgress: (current, total, currentItem) => {
        progressCalls.push({ current, total, currentItem });
      }
    });

    expect(progressCalls.length).toBe(2);
    expect(progressCalls[0]).toEqual({ current: 1, total: 2, currentItem: 'logo.png' });
    expect(progressCalls[1]).toEqual({ current: 2, total: 2, currentItem: 'vetor-1.svg' });

    expect(result.moduleId).toBe('images-zip');
    expect(result.filename).toBe('Fotos-imagens.zip');
    expect(result.mimeType).toBe('application/zip');
    expect(result.itemCount).toBe(2);

    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    const unzipped = unzipSync(buffer);

    expect(unzipped['logo.png']).toBeDefined();
    expect(unzipped['vetor-1.svg']).toBeDefined();
    expect(unzipped['index.html']).toBeUndefined(); // Somente imagens, sem html!

    global.fetch = originalFetch;
  });

  it('[SEC-02] sanitizeSvg elimina scripts, foreignObject, animate, handlers e hrefs externos', () => {
    const maliciousSvg = `
      <svg id="bad-svg" xmlns="http://www.w3.org/2000/svg" onload="alert('xss')" onclick="bad()">
        <script>alert(1)</script>
        <foreignObject width="100" height="50">
          <body xmlns="http://www.w3.org/1999/xhtml"><script>alert(2)</script></body>
        </foreignObject>
        <animate onbegin="alert(3)" attributeName="x" dur="1s"/>
        <set onend="alert(4)"/>
        <a href="javascript:alert(5)"><text>Click</text></a>
        <use href="https://attacker.com/malicious.svg#icon"/>
        <image xlink:href="//attacker.com/leak.png"/>
        <circle fill="url(#safe-gradient)" cx="10" cy="10" r="5"/>
        <linearGradient id="safe-gradient"/>
      </svg>
    `;

    const clean = sanitizeSvg(maliciousSvg);

    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('foreignObject');
    expect(clean).not.toContain('<animate');
    expect(clean).not.toContain('<set');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('https://attacker.com');
    expect(clean).not.toContain('//attacker.com');
    expect(clean).toContain('#safe-gradient');
    expect(clean).toContain('<circle');
  });

  it('[NOVO-03] sanitiza SVGs provenientes de data: URLs e downloads remotos antes de adicionar ao ZIP', async () => {
    const rawDataSvg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>evil()</script><rect width="10" height="10"/></svg>';
    const encodedDataSvg = `data:image/svg+xml;utf8,${encodeURIComponent(rawDataSvg)}`;

    const html = `
      <html>
        <body>
          <img src="${encodedDataSvg}">
        </body>
      </html>
    `;

    const result = await imagesZipModule.run({
      url: 'https://example.com',
      title: 'SvgDataTest',
      html
    });

    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    const unzipped = unzipSync(buffer);
    const svgFile = Object.keys(unzipped).find((k) => k.endsWith('.svg'));
    expect(svgFile).toBeDefined();

    const content = new TextDecoder().decode(unzipped[svgFile!]);
    expect(content).not.toContain('<script');
    expect(content).not.toContain('onload');
    expect(content).toContain('<rect');
  });

  it('[NOVO-02] subrecurso de pagina publica para localhost e bloqueado', async () => {
    const html = `
      <html>
        <body>
          <img src="http://localhost:8080/internal.png">
        </body>
      </html>
    `;

    const result = await imagesZipModule.run({
      url: 'https://site-publico.com/index.html',
      title: 'PublicPage',
      html
    });

    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    const unzipped = unzipSync(buffer);
    expect(Object.keys(unzipped).length).toBe(0);
  });
});
