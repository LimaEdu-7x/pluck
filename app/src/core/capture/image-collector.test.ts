import { describe, it, expect, vi } from 'vitest';
import { unzipSync } from 'fflate';
import {
  parseSrcset,
  extractCssUrls,
  collectImagesFromDom,
  captureImagesZip
} from './image-collector';

describe('ImageCollector', () => {
  it('parseSrcset divide e resolve URLs com descritores de densidade e largura', () => {
    const srcset = 'pequeno.jpg 1x, medio.jpg 2x, grande.webp 1200w';
    const urls = parseSrcset(srcset, 'https://example.com/artigo/');
    expect(urls).toEqual([
      'https://example.com/artigo/pequeno.jpg',
      'https://example.com/artigo/medio.jpg',
      'https://example.com/artigo/grande.webp'
    ]);
  });

  it('parseSrcset preserva data: URLs', () => {
    const srcset = 'data:image/png;base64,AAAA 1x, foto.jpg 2x';
    const urls = parseSrcset(srcset, 'https://example.com/');
    expect(urls[0]).toBe('data:image/png;base64,AAAA');
    expect(urls[1]).toBe('https://example.com/foto.jpg');
  });

  it('extractCssUrls extrai URLs de declaracoes CSS', () => {
    const css = "background-image: url('banner.png'); background: url(/fundo.jpg) no-repeat;";
    const urls = extractCssUrls(css, 'https://example.com/page/');
    expect(urls).toEqual([
      'https://example.com/page/banner.png',
      'https://example.com/fundo.jpg'
    ]);
  });

  it('collectImagesFromDom varre img, srcset, picture, CSS background e SVG inline com deduplicacao', () => {
    const html = `
      <html>
        <body style="background-image: url('/bg-body.png');">
          <img src="/logo.png" alt="Logo">
          <!-- Imagem duplicada que deve ser deduplicada -->
          <img src="/logo.png" alt="Logo Duplicado">
          
          <picture>
            <source srcset="/hero-mobile.webp 400w, /hero-desktop.webp 1000w">
            <img src="/hero-fallback.jpg" srcset="/hero-1x.jpg 1x, /hero-2x.jpg 2x">
          </picture>

          <div style="background: url('/card-bg.jpg');">Card</div>

          <!-- Data URL -->
          <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==">

          <!-- SVG inline -->
          <svg id="icone-estrela" viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="5"/>
          </svg>
        </body>
      </html>
    `;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const candidates = collectImagesFromDom(doc, 'https://meusite.com/blog/');

    // Verifica que logo.png aparece apenas uma vez (deduplicado)
    const logoCandidates = candidates.filter((c) => c.url === 'https://meusite.com/logo.png');
    expect(logoCandidates.length).toBe(1);

    // Verifica presenca das diferentes origens
    const urls = candidates.map((c) => c.url);
    expect(urls).toContain('https://meusite.com/logo.png'); // img src
    expect(urls).toContain('https://meusite.com/bg-body.png'); // body background
    expect(urls).toContain('https://meusite.com/hero-mobile.webp'); // picture source
    expect(urls).toContain('https://meusite.com/hero-desktop.webp'); // picture source
    expect(urls).toContain('https://meusite.com/hero-1x.jpg'); // img srcset
    expect(urls).toContain('https://meusite.com/card-bg.jpg'); // div style
    expect(urls.some((u) => u.startsWith('data:image/png;base64'))).toBe(true); // data: URL
    expect(urls.some((u) => u.startsWith('inline-svg://'))).toBe(true); // svg inline
  });

  it('captureImagesZip empacota imagens nativas em ZIP e tolera falhas de CORS', async () => {
    const originalFetch = global.fetch;

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('foto.jpg')) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'image/jpeg' }),
          arrayBuffer: async () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer
        };
      }
      if (url.includes('vetor.svg')) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'image/svg+xml' }),
          arrayBuffer: async () => new TextEncoder().encode('<svg></svg>').buffer
        };
      }
      if (url.includes('cors-error.png')) {
        throw new TypeError('Blocked by CORS');
      }
      return { ok: false };
    });

    const candidates = [
      { url: 'https://exemplo.com/foto.jpg', type: 'image' as const, preferredName: 'foto-perfil' },
      { url: 'https://cdn.exemplo.com/vetor.svg', type: 'image' as const, preferredName: 'icone' },
      { url: 'https://bloqueado.com/cors-error.png', type: 'image' as const, preferredName: 'bloqueado' },
      {
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        type: 'data-url' as const,
        preferredName: 'pixel-data'
      },
      {
        url: 'inline-svg://logo',
        type: 'svg-inline' as const,
        content: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
        preferredName: 'meu-logo.svg'
      }
    ];

    const result = await captureImagesZip({
      candidates,
      title: 'Minhas Fotos'
    });

    expect(result.filename).toBe('Minhas Fotos-imagens.zip');
    expect(result.stats.totalAssets).toBe(5);
    expect(result.stats.savedAssets).toBe(4); // 4 salvas com sucesso
    expect(result.stats.corsBlockedAssets).toBe(1); // 1 ignorada por CORS sem quebrar

    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    const unzipped = unzipSync(buffer);

    // Formatos nativos preservados (SEM converter para WebP!)
    expect(unzipped['foto-perfil.jpg']).toBeDefined();
    expect(unzipped['icone.svg']).toBeDefined();
    expect(unzipped['pixel-data.png']).toBeDefined();
    expect(unzipped['meu-logo.svg']).toBeDefined();

    // O arquivo com falha de CORS não existe no zip, mas o processo foi 100% resiliente
    expect(unzipped['bloqueado.png']).toBeUndefined();

    global.fetch = originalFetch;
  });
});
