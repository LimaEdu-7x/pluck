import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureFaithfulSite } from './faithful-engine';

// Fixture no estilo Next.js + privacidade: tipos citados no relatorio (B1), extensao (B4) e token de terceiro (B4)
const PAGE = 'https://site.exemplo.com/dashboard';
const MB = 1024 * 1024;

function bin(n: number, seed: number): Uint8Array {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 255;
  return u;
}

export function fixtureInput(mediaCount = 10) {
  const html = `<!DOCTYPE html><html><head>
  <link rel="stylesheet" href="/_next/static/chunks/2ox-wnci8lexv.css">
  <link rel="icon" href="/_next/static/media/icon.webp">
  <link rel="preload" href="/_next/static/media/f.woff2" as="font" type="font/woff2" crossorigin>
  <script src="/_next/static/chunks/main-abc.js" async></script>
  </head><body><h1>Painel</h1></body></html>`;

  const customResources: any[] = [
    { url: PAGE, mimeType: 'text/html', statusCode: 200, data: html },
    { url: `${PAGE.replace('/dashboard', '')}/_next/static/chunks/2ox-wnci8lexv.css`, mimeType: 'text/css', statusCode: 200, data: 'body{margin:0}' },
    { url: 'https://site.exemplo.com/_next/static/chunks/main-abc.js', mimeType: 'application/javascript', statusCode: 200, data: 'console.log(1)' },
    { url: 'https://site.exemplo.com/_next/static/media/icon.webp', mimeType: 'image/webp', statusCode: 200, data: bin(2048, 1) },
    { url: 'https://site.exemplo.com/_next/static/media/f.woff2', mimeType: 'font/woff2', statusCode: 200, data: bin(4096, 2) },
    { url: 'chrome-extension://abcdefghijklmnop/injectScript.js', mimeType: 'application/javascript', statusCode: 200, data: 'x' },
    { url: 'https://cdn.terceiro.com/lib.js?t=SEGREDO123&r=us', mimeType: 'application/javascript', statusCode: 200, data: 'y' }
  ];
  // 40 respostas RSC de prefetch do Next (a query _rsc muda a cada uma)
  for (let i = 0; i < 40; i++) {
    customResources.push({
      url: `https://site.exemplo.com/__next._tree.txt?_rsc=rsc${i}`,
      mimeType: 'text/x-component',
      statusCode: 200,
      data: `0:["rsc",${i}]`
    });
  }
  // midias grandes que passam do teto escolhido pelo usuario
  for (let i = 0; i < mediaCount; i++) {
    customResources.push({
      url: `https://site.exemplo.com/media/video${i}.mp4`,
      mimeType: 'video/mp4',
      statusCode: 200,
      data: bin(1.5 * MB, 10 + i)
    });
  }
  return { html, customResources };
}

// Invariantes que a copia precisa cumprir
export function checkInvariants(result: any) {
  const urlmap: Record<string, string> = JSON.parse(new TextDecoder().decode(result.files['urlmap.json']));
  const missing = Object.entries(urlmap).filter(([, target]) => !result.files[target]);
  const keys = Object.keys(urlmap).join('\n');
  const zipNames = Object.keys(result.files).join('\n');
  // Conteúdo de HTML/CSS/JS também não pode carregar extensão ou token
  const textos = Object.entries(result.files)
    .filter(([name]) => /\.(html?|css|js)$/i.test(name))
    .map(([, bytes]) => new TextDecoder().decode(bytes as Uint8Array))
    .join('\n');
  return {
    urlmapEntries: Object.keys(urlmap).length,
    zipFiles: Object.keys(result.files).length,
    targetsSemArquivo: missing.length,
    temExtensao: /chrome-extension:|moz-extension:/.test(keys + zipNames + textos),
    temToken: /SEGREDO123/.test(keys + zipNames + textos),
    urlmap
  };
}

describe('B1: urlmap x arquivos no ZIP (fixture com os tipos do relatorio)', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    // Sem rede: o download estatico nao acha nada
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as any;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('todo item do urlmap aponta para arquivo gravado, sem extensao do navegador e sem token', async () => {
    const { html, customResources } = fixtureInput();
    const result: any = await captureFaithfulSite({
      url: PAGE,
      html,
      mode: 'page',
      title: 'Painel',
      customResources,
      limits: { maxBytes: 4 * MB } as any
    } as any);

    const c = checkInvariants(result);
    console.log(
      `[B1] urlmap=${c.urlmapEntries} entradas | arquivos no ZIP=${c.zipFiles} | alvos sem arquivo=${c.targetsSemArquivo} | warnings=${JSON.stringify(result.warnings || {})}`
    );
    expect(c.targetsSemArquivo).toBe(0);
    expect(c.temExtensao).toBe(false);
    expect(c.temToken).toBe(false);
  });

  it('o teto escolhido pelo usuario aparece como aviso, nunca como corte silencioso', async () => {
    const { html, customResources } = fixtureInput();
    const result: any = await captureFaithfulSite({
      url: PAGE,
      html,
      mode: 'page',
      title: 'Painel',
      customResources,
      limits: { maxBytes: 4 * MB } as any
    } as any);
    expect(result.warnings?.limitReached).toBe('bytes');
    expect(result.warnings?.skippedAssets).toBeGreaterThan(0);
  });

  it('com o limite escolhido maior (500 MB), o corte de 150 MB nao acontece', async () => {
    // 110 midias de 1,5 MB = ~165 MB: acima do corte fixo antigo (150 MB), abaixo do escolhido (500 MB)
    const { html, customResources } = fixtureInput(110);
    const result: any = await captureFaithfulSite({
      url: PAGE,
      html,
      mode: 'page',
      title: 'Painel',
      customResources,
      limits: { maxBytes: 500 * MB } as any
    } as any);
    const c = checkInvariants(result);
    expect(result.warnings?.limitReached).toBeUndefined();
    expect(c.urlmapEntries).toBeGreaterThanOrEqual(40 + 10);
    expect(c.targetsSemArquivo).toBe(0);
  });
});
