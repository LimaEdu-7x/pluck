import { describe, it, expect } from 'vitest';
import { cleanUrlTokens, decodeHtmlEntities, isBrowserExtensionUrl } from '../security/privacy-cleaner';
import { mapUrlToZipPath, rewriteHtmlDocument } from './rewriter';

const PAGE = 'https://site.exemplo.com/dashboard';

describe('privacidade do urlmap (B4)', () => {
  it('reconhece URLs de extensões do navegador e nunca as mapeia', () => {
    expect(isBrowserExtensionUrl('chrome-extension://abcdefghijklmnop/injectScript.js')).toBe(true);
    expect(isBrowserExtensionUrl('moz-extension://1234/x.js')).toBe(true);
    expect(isBrowserExtensionUrl('https://cdn.exemplo.com/x.js')).toBe(false);
    expect(mapUrlToZipPath('chrome-extension://abcdefghijklmnop/injectScript.js', PAGE)).toBe('');
    expect(mapUrlToZipPath('moz-extension://1234/x.js', PAGE)).toBe('');
  });

  it('remove t= e r= de terceiros (token e região), sem mexer na própria origem', () => {
    const terceiro = cleanUrlTokens('https://analytics.terceiro.com/s.js?t=SEGREDO123&r=us&v=2', PAGE);
    expect(terceiro).not.toContain('t=SEGREDO123');
    expect(terceiro).not.toMatch(/[?&]r=/);
    expect(terceiro).toContain('v=2');
    const propria = cleanUrlTokens('https://site.exemplo.com/a.js?t=1700000000', PAGE);
    expect(propria).toContain('t=1700000000');
  });

  it('remove token, session e auth de qualquer origem', () => {
    const u = cleanUrlTokens('https://site.exemplo.com/api/x?token=ABC&session_id=XYZ&q=1', PAGE);
    expect(u).not.toContain('ABC');
    expect(u).not.toContain('XYZ');
    expect(u).toContain('q=1');
  });
});

describe('entidades HTML e deduplicação (B2)', () => {
  it('decodifica &amp; antes de normalizar', () => {
    expect(decodeHtmlEntities('https://fonts.googleapis.com/css2?family=A&amp;display=swap')).toBe(
      'https://fonts.googleapis.com/css2?family=A&display=swap'
    );
  });

  it('a mesma URL com &amp; e com & vira um único item no urlmap', () => {
    const comEntidade = mapUrlToZipPath('https://fonts.googleapis.com/css2?family=A&amp;display=swap', PAGE);
    const comE = mapUrlToZipPath('https://fonts.googleapis.com/css2?family=A&display=swap', PAGE);
    expect(comEntidade).toBe(comE);
    expect(comE).not.toBe('');
  });
});

describe('caminhos relativos (B3)', () => {
  it('href e src de _next/ viram caminho relativo, nunca barra inicial', () => {
    const map = new Map<string, string>([
      ['https://site.exemplo.com/_next/static/chunks/2ox-wnci8lexv.css', '_next/static/chunks/2ox-wnci8lexv.css'],
      ['https://site.exemplo.com/_next/static/chunks/main.js', '_next/static/chunks/main.js']
    ]);
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="/_next/static/chunks/2ox-wnci8lexv.css">
      <script src="/_next/static/chunks/main.js"></script>
    </head><body></body></html>`;
    const out = rewriteHtmlDocument(html, PAGE, 'dashboard.html', map, true, true);
    expect(out).not.toMatch(/href="\/_next/);
    expect(out).not.toMatch(/src="\/_next/);
    expect(out).toContain('_next/static/chunks/2ox-wnci8lexv.css');
  });
});
