import { describe, it, expect } from 'vitest';
import {
  mapUrlToZipPath,
  getRelativePath,
  dropCdnGuards,
  normalizeImages,
  sanitizeSensitiveFields,
  injectFaithfulCsp,
  rewriteHtmlDocument,
  rewriteCssContent,
  FAITHFUL_META_CSP
} from './rewriter';

describe('Rewriter Fiel: Mapeamento de Caminhos e Isolamento de CDNs', () => {
  const base = 'https://meusite.com/';

  it('mapeia a raiz da mesma origem para index.html', () => {
    expect(mapUrlToZipPath('https://meusite.com/', base)).toBe('index.html');
    expect(mapUrlToZipPath('https://meusite.com', base)).toBe('index.html');
  });

  it('mapeia páginas internas da mesma origem adicionando .html quando necessário', () => {
    expect(mapUrlToZipPath('https://meusite.com/sobre', base)).toBe('sobre.html');
    expect(mapUrlToZipPath('https://meusite.com/contato/', base)).toBe('contato/index.html');
    expect(mapUrlToZipPath('https://meusite.com/app/dashboard.html', base)).toBe('app/dashboard.html');
  });

  it('mapeia assets externos de CDNs para a pasta _external/<hostname>/', () => {
    const cdnUrl = 'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/react.production.min.js';
    const mapped = mapUrlToZipPath(cdnUrl, base);
    expect(mapped).toBe('_external/cdnjs.cloudflare.com/ajax/libs/react/18.2.0/react.production.min.js');
  });

  it('evita colisão de nomes entre duas CDNs diferentes com o mesmo arquivo', () => {
    const cdn1 = 'https://cdn.a.com/lib.js';
    const cdn2 = 'https://cdn.b.com/lib.js';
    expect(mapUrlToZipPath(cdn1, base)).toBe('_external/cdn.a.com/lib.js');
    expect(mapUrlToZipPath(cdn2, base)).toBe('_external/cdn.b.com/lib.js');
  });

  it('bloqueia sub-recursos de IPs privados e loopback quando a página base é remota (FIEL-09)', () => {
    expect(mapUrlToZipPath('http://127.0.0.1:8080/sub.js', base)).toBe('');
    expect(mapUrlToZipPath('http://localhost:3000/style.css', base)).toBe('');
    expect(mapUrlToZipPath('http://192.168.1.1/tracker.png', base)).toBe('');
    expect(mapUrlToZipPath('http://10.0.0.5/api.json', base)).toBe('');
    expect(mapUrlToZipPath('http://[::1]:8080/font.woff2', base)).toBe('');
  });

  it('permite localhost quando a página base é legítima local (FIEL-09)', () => {
    const localBase = 'http://localhost:3000/';
    expect(mapUrlToZipPath('http://localhost:3000/style.css', localBase)).toBe('style.css');
  });

  it('calcula caminho relativo corretamente entre diferentes diretórios no ZIP', () => {
    expect(getRelativePath('index.html', 'assets/foto.webp')).toBe('assets/foto.webp');
    expect(getRelativePath('blog/post.html', 'assets/foto.webp')).toBe('../assets/foto.webp');
    expect(getRelativePath('blog/sub/post.html', 'assets/foto.webp')).toBe('../../assets/foto.webp');
    expect(getRelativePath('index.html', '_external/cdn.com/style.css')).toBe('_external/cdn.com/style.css');
    expect(getRelativePath('paginas/sobre.html', '_external/cdn.com/style.css')).toBe('../_external/cdn.com/style.css');
  });
});

describe('Rewriter Fiel: Higienização e Remoção de Travas de CDN (SRI e CORS)', () => {
  it('remove atributos integrity e crossorigin de tags link e script', () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="style.css" integrity="sha384-xyz" crossorigin="anonymous">
          <script src="app.js" integrity="sha256-abc" crossorigin="use-credentials"></script>
        </head>
        <body></body>
      </html>
    `;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    dropCdnGuards(doc);

    const link = doc.querySelector('link');
    expect(link?.hasAttribute('integrity')).toBe(false);
    expect(link?.hasAttribute('crossorigin')).toBe(false);

    const script = doc.querySelector('script');
    expect(script?.hasAttribute('integrity')).toBe(false);
    expect(script?.hasAttribute('crossorigin')).toBe(false);
  });

  it('converte loading="lazy" para loading="eager" e reescreve srcset', () => {
    const html = `
      <html>
        <body>
          <img id="img1" src="https://cdn.com/foto.jpg" loading="lazy" srcset="https://cdn.com/foto.jpg 1x, https://cdn.com/foto-2x.jpg 2x">
        </body>
      </html>
    `;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const map = new Map<string, string>([
      ['https://cdn.com/foto.jpg', '_external/cdn.com/foto.jpg'],
      ['https://cdn.com/foto-2x.jpg', '_external/cdn.com/foto-2x.jpg']
    ]);

    normalizeImages(doc, 'index.html', map);

    const img = doc.getElementById('img1');
    expect(img?.getAttribute('loading')).toBe('eager');
    expect(img?.getAttribute('srcset')).toContain('_external/cdn.com/foto.jpg 1x');
    expect(img?.getAttribute('srcset')).toContain('_external/cdn.com/foto-2x.jpg 2x');
  });

  it('remove campos de senha e neutraliza tokens e forms', () => {
    const html = `
      <html>
        <body>
          <form action="/login" method="POST">
            <input type="text" name="user" value="joao">
            <input type="password" name="pass" value="secreta">
            <input type="hidden" name="csrf_token" value="abc123xyz">
            <button type="submit">Entrar</button>
          </form>
        </body>
      </html>
    `;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    sanitizeSensitiveFields(doc);

    expect(doc.querySelector('input[type="password"]')).toBeNull();
    const csrf = doc.querySelector('input[name="csrf_token"]');
    expect(csrf?.getAttribute('value')).toBe('');
    const form = doc.querySelector('form');
    expect(form?.hasAttribute('action')).toBe(false);
    expect(form?.getAttribute('onsubmit')).toBe('return false;');
  });

  it('injeta Meta CSP com segurança local sem quebrar scripts do app (FIEL-08)', () => {
    const html = `<html><head><title>Teste</title></head><body></body></html>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    injectFaithfulCsp(doc);

    const cspMeta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(cspMeta).not.toBeNull();
    const content = cspMeta?.getAttribute('content') || '';
    expect(content).toBe(FAITHFUL_META_CSP);
    expect(content).toContain("object-src 'none'");
    expect(content).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:");
    expect(content).not.toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' data:");
    expect(content).toContain("connect-src 'self' blob:");
    expect(content).not.toContain("connect-src 'self' data:");
  });

  it('remove links de dns-prefetch e preconnect para evitar vazamento de consultas DNS (FIEL-08)', () => {
    const html = `
      <html>
        <head>
          <link rel="dns-prefetch" href="//telemetria.com">
          <link rel="preconnect" href="https://tracker.externo.com">
          <link rel="stylesheet" href="style.css">
        </head>
        <body></body>
      </html>
    `;
    const rewritten = rewriteHtmlDocument(html, 'https://empresa.com/', 'index.html', new Map([['https://empresa.com/style.css', 'style.css']]));
    expect(rewritten).not.toContain('dns-prefetch');
    expect(rewritten).not.toContain('preconnect');
    expect(rewritten).not.toContain('telemetria.com');
    expect(rewritten).not.toContain('tracker.externo.com');
  });
});

describe('Rewriter Fiel: Reescrita Completa de Documento HTML e CSS', () => {
  it('reescreve links, scripts e âncoras para caminhos locais relativos', () => {
    const pageUrl = 'https://empresa.com/';
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="https://empresa.com/css/main.css">
          <script src="https://cdn.externo.com/bundle.js"></script>
        </head>
        <body>
          <a href="https://empresa.com/sobre">Sobre Nós</a>
          <img src="https://empresa.com/img/logo.png">
        </body>
      </html>
    `;
    const map = new Map<string, string>([
      ['https://empresa.com/css/main.css', 'css/main.css'],
      ['https://cdn.externo.com/bundle.js', '_external/cdn.externo.com/bundle.js'],
      ['https://empresa.com/sobre', 'sobre.html'],
      ['https://empresa.com/img/logo.png', 'img/logo.png']
    ]);

    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);

    expect(rewritten).toContain('href="css/main.css"');
    expect(rewritten).toContain('src="_external/cdn.externo.com/bundle.js"');
    expect(rewritten).toContain('href="sobre.html"');
    expect(rewritten).toContain('src="img/logo.png"');
    expect(rewritten).toContain('Content-Security-Policy');
  });

  it('reescreve URLs em arquivos CSS (@import e url())', () => {
    const cssText = `
      @import url("https://fonts.googleapis.com/css2?family=Inter");
      .hero {
        background-image: url('../images/banner.webp');
      }
      .icon {
        background: url('https://cdn.com/icon.svg');
      }
    `;
    const cssUrl = 'https://empresa.com/css/main.css';
    const map = new Map<string, string>([
      ['https://fonts.googleapis.com/css2?family=Inter', '_external/fonts.googleapis.com/css2.css'],
      ['https://empresa.com/images/banner.webp', 'images/banner.webp'],
      ['https://cdn.com/icon.svg', '_external/cdn.com/icon.svg']
    ]);

    const rewritten = rewriteCssContent(cssText, cssUrl, 'css/main.css', map);

    expect(rewritten).toContain('url("../_external/fonts.googleapis.com/css2.css")');
    expect(rewritten).toContain("url('../images/banner.webp')");
    expect(rewritten).toContain("url('../_external/cdn.com/icon.svg')");
  });
});
