import { describe, it, expect } from 'vitest';
import {
  mapUrlToZipPath,
  getRelativePath,
  dropCdnGuards,
  dropDynamicRevealArtifacts,
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

  it('reescreve URLs em atributos style inline em elementos (ex: background-image)', () => {
    const pageUrl = 'https://landonorris.com/';
    const html = `
      <html>
        <body>
          <div id="hero" style="background-image: url('https://cdn.prod.website-files.com/img1.webp'); height: 100px;"></div>
          <div id="mask" style="-webkit-mask-image: url(https://cdn.prod.website-files.com/mask.svg);"></div>
        </body>
      </html>
    `;
    const map = new Map<string, string>([
      ['https://cdn.prod.website-files.com/img1.webp', '_external/cdn.prod.website-files.com/img1.webp'],
      ['https://cdn.prod.website-files.com/mask.svg', '_external/cdn.prod.website-files.com/mask.svg']
    ]);

    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);

    expect(rewritten).toContain('url(\'_external/cdn.prod.website-files.com/img1.webp\')');
    expect(rewritten).toContain('url(_external/cdn.prod.website-files.com/mask.svg)');
  });

  it('resolve imagens mesmo quando possuem query parameters desiguais', () => {
    const html = `
      <html>
        <body>
          <img id="logo" src="https://cdn.com/logo.png?v=2">
          <picture>
            <source srcset="https://cdn.com/photo.webp?w=800 800w">
          </picture>
        </body>
      </html>
    `;
    const map = new Map<string, string>([
      ['https://cdn.com/logo.png', '_external/cdn.com/logo.png'],
      ['https://cdn.com/photo.webp', '_external/cdn.com/photo.webp']
    ]);

    const doc = new DOMParser().parseFromString(html, 'text/html');
    normalizeImages(doc, 'index.html', map, 'https://cdn.com');

    const img = doc.getElementById('logo');
    expect(img?.getAttribute('src')).toBe('_external/cdn.com/logo.png');

    const src = doc.querySelector('source');
    expect(src?.getAttribute('srcset')).toContain('_external/cdn.com/photo.webp 800w');
  });

  it('mapeia URLs de páginas de domínios externos sem extensão adicionando .html', () => {
    const base = 'https://landonorris.com/';
    expect(mapUrlToZipPath('https://landonorris.store/', base)).toBe('_external/landonorris.store/index.html');
    expect(mapUrlToZipPath('https://landonorris.store/collections/featured', base)).toBe('_external/landonorris.store/collections/featured.html');
  });

  it('reescreve links para domínios externos autorizados/capturados para o caminho local', () => {
    const pageUrl = 'https://landonorris.com/';
    const html = `
      <html>
        <body>
          <a href="https://landonorris.store/">Loja Oficial</a>
          <a href="https://store.landonorris.com/">Subdomínio Loja</a>
        </body>
      </html>
    `;
    const map = new Map<string, string>([
      ['https://landonorris.store/', '_external/landonorris.store/index.html'],
      ['https://store.landonorris.com/', '_external/landonorris.store/index.html']
    ]);

    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);

    expect(rewritten).toContain('href="_external/landonorris.store/index.html"');
    expect(rewritten).not.toContain('href="offline-fallback.html"');
  });

  it('redireciona links para domínios externos NÃO capturados para offline-fallback.html', () => {
    const pageUrl = 'https://landonorris.com/';
    const html = `
      <html>
        <body>
          <a href="https://landonorris.store/">Loja Não Confirmada</a>
          <a href="https://instagram.com/perfil">Rede Social</a>
        </body>
      </html>
    `;
    // Mapa vazio: domínio não foi confirmado nem capturado
    const map = new Map<string, string>();

    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);

    expect(rewritten).toContain('href="offline-fallback.html"');
    expect(rewritten).toContain('data-pluck-uncaptured="true"');
    expect(rewritten).toContain('title="Domínio externo não incluído (landonorris.store)"');
  });

  it('remove artefatos de reveal (.high-line-reveal, etc.) que causam barras sólidas duplicadas', () => {
    const html = `
      <html>
        <body>
          <div class="nav-menu-w">
            <div data-nav-link-highlight="" class="text-eyebrow">
              <span class="line">MCLAREN F1 SINCE 2019</span>
              <div class="high-line-reveal" style="transform: matrix(1, 0, 0, 1, 0, 0); background-color: rgb(210, 255, 0);"></div>
            </div>
            <div class="item-reveal"></div>
            <div class="img-highlight-reveal"></div>
          </div>
        </body>
      </html>
    `;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    dropDynamicRevealArtifacts(doc);

    expect(doc.querySelector('.high-line-reveal')).toBeNull();
    expect(doc.querySelector('.item-reveal')).toBeNull();
    expect(doc.querySelector('.img-highlight-reveal')).toBeNull();
    expect(doc.querySelector('.text-eyebrow')?.textContent).toContain('MCLAREN F1 SINCE 2019');
  });

  it('reescreve fontes com caracteres codificados (%2C) e URLs com hash/query no CSS', () => {
    const cssText = `
      @font-face {
        font-family: "Mona Sans Variable";
        src: url("https://cdn.prod.website-files.com/67b5a02dc5d338960b17a7e9/67bc6274c5b4108b123aa4d5_MonaSans-VariableFont_wdth%2Cwght.woff2") format("woff2");
      }
      .nav-menu-bg {
        background-image: url("https://cdn.prod.website-files.com/67b5a02dc5d338960b17a7e9/67dbeb1e708b818bc15a8d17_blobs_nav.svg?v=1#nav");
      }
    `;
    const cssUrl = 'https://cdn.prod.website-files.com/67b5a02dc5d338960b17a7e9/css/theme.css';
    const cssZip = '_external/cdn.prod.website-files.com/67b5a02dc5d338960b17a7e9/css/theme.css';
    const map = new Map<string, string>([
      ['https://cdn.prod.website-files.com/67b5a02dc5d338960b17a7e9/67bc6274c5b4108b123aa4d5_MonaSans-VariableFont_wdth,wght.woff2', '_external/cdn.prod.website-files.com/67b5a02dc5d338960b17a7e9/67bc6274c5b4108b123aa4d5_MonaSans-VariableFont_wdth,wght.woff2'],
      ['https://cdn.prod.website-files.com/67b5a02dc5d338960b17a7e9/67dbeb1e708b818bc15a8d17_blobs_nav.svg', '_external/cdn.prod.website-files.com/67b5a02dc5d338960b17a7e9/67dbeb1e708b818bc15a8d17_blobs_nav.svg']
    ]);

    const rewritten = rewriteCssContent(cssText, cssUrl, cssZip, map);

    expect(rewritten).toContain('url("../67bc6274c5b4108b123aa4d5_MonaSans-VariableFont_wdth,wght.woff2")');
    expect(rewritten).toContain('url("../67dbeb1e708b818bc15a8d17_blobs_nav.svg")');
    expect(rewritten).not.toContain('https://cdn.prod.website-files.com');
  });

  it('preserva tags e scripts após SVG contendo <style> inline (evita truncamento de happy-dom)', () => {
    const pageUrl = 'https://landonorris.store/';
    const html = `
      <html>
        <body>
          <div class="footer">
            <svg viewBox="0 0 100 100">
              <defs><style>.cls-1{fill:#e8ff00;}</style></defs>
              <path class="cls-1" d="M0,0 L10,10" />
            </svg>
          </div>
          <div class="after-footer">Conteúdo Preservado</div>
          <script src="//landonorris.store/cdn/shop/t/119/assets/radiant.js?v=48222110410338539561794414054" type="module" defer></script>
        </body>
      </html>
    `;
    const map = new Map<string, string>([
      ['https://landonorris.store/cdn/shop/t/119/assets/radiant.js?v=48222110410338539561794414054', 'cdn/shop/t/119/assets/radiant.5ad958.js']
    ]);

    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);

    expect(rewritten).toContain('Conteúdo Preservado');
    expect(rewritten).toContain('src="cdn/shop/t/119/assets/radiant.5ad958.js"');
    expect(rewritten).toContain('<defs><style>.cls-1{fill:#e8ff00;}</style></defs>');
  });

  it('remove scripts de trackers e telemetria Shopify e de terceiros (klaviyo, gorgias, preloads, perf-kit)', () => {
    const pageUrl = 'https://landonorris.store/';
    const html = `
      <html>
        <head>
          <script src="/checkouts/internal/preloads.js?locale=en-GB"></script>
          <script src="https://static.klaviyo.com/onsite/js/XWvzdS/klaviyo.js"></script>
          <script src="https://config.gorgias.chat/bundle-loader/shopify/store.js"></script>
          <script src="https://cdn.shopify.com/shopifycloud/perf-kit/shopify-perf-kit-3.16.1.min.js"></script>
          <script src="https://cdn.shopify.com/shopifycloud/shop-js/modules/v2/loader.init-shop-cart-sync.en.esm.js"></script>
        </head>
        <body>
          <script>var wpmLoader=function(){"use strict";};</script>
          <script>window.__TREKKIE_SHIM_QUEUE = [];</script>
          <script>window.PurpleDotConfig = {};</script>
        </body>
      </html>
    `;
    const map = new Map<string, string>();
    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);

    expect(rewritten).not.toContain('preloads.js');
    expect(rewritten).not.toContain('klaviyo.js');
    expect(rewritten).not.toContain('gorgias.chat');
    expect(rewritten).not.toContain('perf-kit');
    expect(rewritten).not.toContain('loader.init-shop-cart-sync');
    expect(rewritten).not.toContain('wpmLoader');
    expect(rewritten).not.toContain('__TREKKIE_SHIM_QUEUE');
    expect(rewritten).not.toContain('PurpleDotConfig');
  });

  it('injeta fallback CSS de visibilidade para seletores de moeda com Choices.js', () => {
    const pageUrl = 'https://landonorris.store/';
    const html = `
      <html>
        <head></head>
        <body>
          <div class="currency-selector flex">
            <select data-select-url="" data-choices="">
              <option value="GBP" selected>GBP</option>
            </select>
          </div>
        </body>
      </html>
    `;
    const map = new Map<string, string>();
    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);

    expect(rewritten).toContain('.currency-selector select[data-choices]');
    expect(rewritten).toContain('opacity: 1 !important');
    expect(rewritten).toContain('background: transparent !important');
    expect(rewritten).toContain('background-color: transparent !important');
  });

  it('dropDynamicRevealArtifacts garante que menus de navegação capturados abertos sejam resetados para fechados', () => {
    const pageUrl = 'https://landonorris.com/';
    const html = `
      <html>
        <head></head>
        <body>
          <div data-nav-m="" class="nav-menu-w" style="display: flex; clip-path: ellipse(120% 100% at 50% 20%);">
            <div class="high-line-reveal" style="transform: scaleX(1);"></div>
          </div>
        </body>
      </html>
    `;
    const map = new Map<string, string>();
    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);

    expect(rewritten).toContain('display: none');
    expect(rewritten).not.toContain('class="high-line-reveal"');
  });

  it('substitui imagens unmapped em arquivos CSS por BLOCKED_IMAGE_DATA evitando 404', () => {
    const cssText = `
      .loading-spinner {
        background-image: url("../../../assets/icon-loading.svg");
      }
    `;
    const cssUrl = 'https://landonorris.store/cdn/shop/t/119/assets/radiant.css';
    const cssZip = '_external/landonorris.store/cdn/shop/t/119/assets/radiant.7a4c65.css';
    const map = new Map<string, string>();

    const rewritten = rewriteCssContent(cssText, cssUrl, cssZip, map);

    expect(rewritten).toContain('url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")');
    expect(rewritten).not.toContain('icon-loading.svg');
  });

  it('reescreve imagens dentro de Declarative Shadow DOM (<template shadowrootmode="open">)', () => {
    const pageUrl = 'https://www.youtube.com/';
    const html = `
      <html>
        <head></head>
        <body>
          <yt-img-shadow>
            <template shadowrootmode="open">
              <img id="img" src="https://i.ytimg.com/vi/abc/hq720.jpg?sqp=test" loading="lazy">
            </template>
          </yt-img-shadow>
        </body>
      </html>
    `;
    const map = new Map<string, string>();
    map.set(
      'https://i.ytimg.com/vi/abc/hq720.jpg?sqp=test',
      '_external/i.ytimg.com/vi/abc/hq720.jpg'
    );

    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map);
    expect(rewritten).toContain('_external/i.ytimg.com/vi/abc/hq720.jpg');
    expect(rewritten).toContain('loading="eager"');
  });

  it('mapeia URLs de stylesheet sem extensão do YouTube (/ss/) e Google Fonts (/css2) para .css', () => {
    const ytCss = 'https://www.youtube.com/s/_/ytmainappweb/_/ss/k=ytmainappweb.kevlar_base.hnYKxBnuqUc.L.B1.O/am=AAAAAAAgwACAAOwJ/d=0/br=1/rs=AGKMywF7Mm6pMAnPGtU6BFN339VmxEnlQQ';
    const mappedYt = mapUrlToZipPath(ytCss, 'https://www.youtube.com/');
    expect(mappedYt.endsWith('.css')).toBe(true);

    const gFonts = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;700';
    const mappedGFonts = mapUrlToZipPath(gFonts, 'https://www.youtube.com/');
    expect(mappedGFonts).toContain('_external/fonts.googleapis.com/');
    expect(mappedGFonts.endsWith('.css')).toBe(true);
  });

  it('desliga scripts de aplicação em modo foto fiel para SPAs pesadas', () => {
    const pageUrl = 'https://www.youtube.com/';
    const html = `
      <html>
        <head>
          <link rel="preload" href="/app.js" as="script">
          <script src="/app.js"></script>
          <script>window.__INITIAL_DATA__ = { foo: 'bar' };</script>
        </head>
        <body>
          <ytd-app><h1>Conteúdo YouTube</h1></ytd-app>
        </body>
      </html>
    `;
    const map = new Map<string, string>();
    const rewritten = rewriteHtmlDocument(html, pageUrl, 'index.html', map, false, true);
    expect(rewritten).toContain('<h1>Conteúdo YouTube</h1>');
    expect(rewritten).not.toContain('<script src="/app.js"></script>');
    expect(rewritten).not.toContain('window.__INITIAL_DATA__');
    expect(rewritten).not.toContain('as="script"');
  });
});
