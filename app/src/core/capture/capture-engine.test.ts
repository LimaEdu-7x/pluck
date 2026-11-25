import { describe, it, expect, vi } from 'vitest';
import { unzipSync } from 'fflate';
import {
  capturePageHtml,
  capturePageZip,
  fetchResourceSafe,
  type PageRawData
} from './capture-engine';

describe('CaptureEngine', () => {
  it('capturePageHtml sanitiza o HTML e devolve blob sem zip', () => {
    const raw: PageRawData = {
      html: '<html><head><script>alert(1)</script></head><body><input type="password" value="123"><h1>Ola</h1></body></html>',
      title: 'Minha Pagina',
      url: 'http://localhost/teste',
      baseURI: 'http://localhost/teste',
      stylesheets: [],
      images: []
    };

    const result = capturePageHtml(raw);
    expect(result.filename).toBe('Minha Pagina.html');
    expect(result.mimeType).toBe('text/html');
    expect(result.sanitizedHtml).not.toContain('<script');
    expect(result.sanitizedHtml).not.toContain('type="password"');
    expect(result.sanitizedHtml).toContain("default-src 'none'");
    expect(result.sanitizedHtml).toContain('<h1>Ola</h1>');
  });

  it('fetchResourceSafe trata data: URLs em base64 com sucesso', async () => {
    // 1x1 transparent PNG em base64
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const res = await fetchResourceSafe(dataUrl);
    expect(res).not.toBeNull();
    expect(res?.mimeType).toBe('image/png');
    expect(res?.data.length).toBeGreaterThan(0);
  });

  it('fetchResourceSafe rejeita esquemas inseguros (javascript: e about:)', async () => {
    expect(await fetchResourceSafe('javascript:alert(1)')).toBeNull();
    expect(await fetchResourceSafe('about:blank')).toBeNull();
    expect(await fetchResourceSafe('')).toBeNull();
  });

  it('[SEC-04] fetchResourceSafe valida URLs com url-guard bloqueando alvos SSRF e hosts privados', async () => {
    const fetchSpy = vi.fn();
    const origFetch = global.fetch;
    global.fetch = fetchSpy;

    // Alvos SSRF proibidos (metadados de nuvem, IPs privados, IPv6 loopback)
    expect(await fetchResourceSafe('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(await fetchResourceSafe('http://192.168.1.1/router')).toBeNull();
    expect(await fetchResourceSafe('http://[::1]/secret')).toBeNull();
    expect(await fetchResourceSafe('http://[::ffff:10.0.0.1]/secret')).toBeNull();

    // fetch não deve ser invocado para URLs bloqueadas pelo url-guard
    expect(fetchSpy).not.toHaveBeenCalled();

    global.fetch = origFetch;
  });

  it('[SSRF] fetchResourceSafe detecta e bloqueia redirecionamentos HTTP para IPs privados ou metadados de nuvem', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        url: 'http://169.254.169.254/latest/meta-data/', // URL final pós-redirecionamento 302
        headers: new Headers({ 'content-type': 'text/plain' }),
        arrayBuffer: async () => new TextEncoder().encode('secret-token').buffer
      };
    });

    const res = await fetchResourceSafe('https://public-cdn.com/asset.png', 5000, false);
    expect(res).toBeNull(); // Bloqueado pela validação da URL final de redirect

    global.fetch = origFetch;
  });

  it('capturePageZip processa assets, reescreve caminhos locais e tolera falha de CORS sem quebrar', async () => {
    // Mock global fetch
    const originalFetch = global.fetch;

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('style.css')) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'text/css' }),
          arrayBuffer: async () => new TextEncoder().encode('body { background: #16181D; }').buffer
        };
      }
      if (url.includes('cors-blocked.png')) {
        // Simula bloqueio de CORS (lança TypeError como o navegador faz)
        throw new TypeError('Failed to fetch (CORS header missing)');
      }
      return { ok: false };
    });

    const raw: PageRawData = {
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Teste Zip</title>
            <link rel="stylesheet" href="http://localhost/style.css">
          </head>
          <body>
            <h1>Titulo</h1>
            <img src="http://cdn.exemplo.com/cors-blocked.png" alt="Bloqueado">
          </body>
        </html>
      `,
      title: 'Teste Zip',
      url: 'http://localhost/pagina',
      baseURI: 'http://localhost/pagina',
      stylesheets: [],
      images: []
    };

    const result = await capturePageZip(raw);
    expect(result.filename).toBe('Teste Zip.zip');
    expect(result.mimeType).toBe('application/zip');
    expect(result.stats.savedAssets).toBe(1); // style.css salvo
    expect(result.stats.corsBlockedAssets).toBe(1); // cors-blocked.png ignorado com contagem

    // Valida o conteúdo descompactado do ZIP
    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    const unzipped = unzipSync(buffer);

    expect(unzipped['index.html']).toBeDefined();
    expect(unzipped['assets/style-1.css']).toBeDefined();

    const cleanHtml = new TextDecoder().decode(unzipped['index.html']);
    // O link do stylesheet foi reescrito para o caminho local
    expect(cleanHtml).toContain('href="assets/style-1.css"');
    // A imagem que falhou CORS permaneceu com o link original e não quebrou o ZIP
    expect(cleanHtml).toContain('http://cdn.exemplo.com/cors-blocked.png');

    // Restaura fetch
    global.fetch = originalFetch;
  });

  it('notifica callback onProgress com contagem real N de assets durante a extração', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('asset1.css') || url.includes('asset2.png')) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'text/css' }
        }));
      }
      return Promise.reject(new Error('Network error'));
    }) as any;

    const progressCalls: { loaded: number; total: number; currentItem?: string }[] = [];
    const raw = {
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <link rel="stylesheet" href="http://localhost/asset1.css">
          </head>
          <body>
            <img src="http://localhost/asset2.png">
          </body>
        </html>
      `,
      title: 'Progresso Real',
      url: 'http://localhost/pagina',
      baseURI: 'http://localhost/pagina',
      stylesheets: [],
      images: []
    };

    const result = await capturePageZip(raw, (loaded, total, currentItem) => {
      progressCalls.push({ loaded, total, currentItem });
    });

    expect(progressCalls.length).toBe(2);
    expect(progressCalls[0]).toEqual({ loaded: 1, total: 2, currentItem: 'style-1' });
    expect(progressCalls[1]).toEqual({ loaded: 2, total: 2, currentItem: 'image-1' });
    expect(result.stats.totalAssets).toBe(2);
    expect(result.stats.savedAssets).toBe(2);

    global.fetch = originalFetch;
  });
});
