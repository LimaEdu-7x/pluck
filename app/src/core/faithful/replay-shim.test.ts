import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateReplayShim, escapeJsonForScript } from './replay-shim';

describe('Pluck Replay Shim', () => {
  const sampleMap: Record<string, string> = {
    'https://assets.example.com/models/helmet.glb': '_external/assets.example.com/models/helmet.glb',
    'https://cdn.example.com/images/hero.webp': '_external/cdn.example.com/images/hero.webp',
    'https://cdn.example.com/fonts/main.woff2': '_external/cdn.example.com/fonts/main.woff2',
    'https://unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm': '_external/unpkg.com/@rive-app/canvas-lite@2.26.4/rive.wasm'
  };

  describe('Segurança contra Injeção de Script / XSS (FIEL-02)', () => {
    it('escapa <, >, &, U+2028 e U+2029 no JSON serializado', () => {
      const malicious = '<script>alert("xss")</script>&foo\u2028bar\u2029';
      const escaped = escapeJsonForScript(JSON.stringify({ key: malicious }));
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
      expect(escaped).not.toContain('&');
      expect(escaped).toContain('\\u003c');
      expect(escaped).toContain('\\u003e');
      expect(escaped).toContain('\\u0026');
      expect(escaped).toContain('\\u2028');
      expect(escaped).toContain('\\u2029');
    });

    it('generateReplayShim neutraliza breakout </script><script> em chaves ou valores', () => {
      const badMap = {
        'https://evil.com/</script><script>alert(1)</script>': '_external/evil/payload.js'
      };
      const shim = generateReplayShim(badMap);
      expect(shim).not.toContain('</script>');
      expect(shim).toContain('\\u003c/script\\u003e');
    });
  });

  it('gera código sem eval e com declaração use strict', () => {
    const shim = generateReplayShim(sampleMap);
    expect(shim).toContain("'use strict';");
    expect(shim).not.toContain('eval(');
    expect(shim).not.toContain('Function(');
  });

  it('serializa o mapa de URLs corretamente no corpo do shim', () => {
    const shim = generateReplayShim(sampleMap);
    expect(shim).toContain('helmet.glb');
    expect(shim).toContain('_external/assets.example.com/models/helmet.glb');
    expect(shim).toContain('_external/cdn.example.com/images/hero.webp');
  });

  describe('Execução do shim no ambiente DOM (Happy-DOM)', () => {
    beforeEach(() => {
      // Limpa estado anterior se houver
      delete (window as any).__PLUCK_URL_MAP__;
      const scriptCode = generateReplayShim(sampleMap);
      const fn = new Function(scriptCode);
      fn();
    });

    it('intercepta HTMLImageElement.src e remapeia URL conhecida', () => {
      const img = document.createElement('img');
      img.src = 'https://cdn.example.com/images/hero.webp';
      expect(img.src).toContain('_external/cdn.example.com/images/hero.webp');
    });

    it('intercepta HTMLImageElement.src com URL externa não mapeada e bloqueia com data URI segura', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const img = document.createElement('img');
      img.src = 'https://unmapped-attacker.com/tracker.png';
      expect(img.src).toMatch(/^data:image\/gif;base64,/);
      expect(warnSpy).toHaveBeenCalledWith(
        '[Pluck Replay] Bloqueado recurso externo não mapeado:',
        'https://unmapped-attacker.com/tracker.png'
      );
      warnSpy.mockRestore();
    });

    it('permite URLs data: e blob: sem alteração', () => {
      const img = document.createElement('img');
      img.src = 'data:image/svg+xml;utf8,<svg></svg>';
      expect(img.src).toBe('data:image/svg+xml;utf8,<svg></svg>');
    });

    it('intercepta srcset e remapeia candidatos conhecidos', () => {
      const img = document.createElement('img');
      img.setAttribute('srcset', 'https://cdn.example.com/images/hero.webp 1x, https://unmapped.com/other.webp 2x');
      const srcset = img.getAttribute('srcset') || '';
      expect(srcset).toContain('_external/cdn.example.com/images/hero.webp');
      expect(srcset).not.toContain('https://unmapped.com/other.webp');
    });

    it('intercepta CSS backgroundImage e remapeia url(...)', () => {
      const div = document.createElement('div');
      div.style.setProperty('background-image', 'url("https://cdn.example.com/images/hero.webp")');
      const bg = div.style.getPropertyValue('background-image');
      expect(bg).toContain('_external/cdn.example.com/images/hero.webp');
    });

    it('bloqueia url(...) externa não mapeada em CSS com data URI segura', () => {
      const div = document.createElement('div');
      div.style.setProperty('background-image', 'url("https://unmapped.com/evil.png")');
      const bg = div.style.getPropertyValue('background-image');
      expect(bg).toContain('data:image/gif;base64');
      expect(bg).not.toContain('https://unmapped.com/evil.png');
    });

    it('declara stubs globais para dataLayer, gtag e ga sem lançar erros', () => {
      expect(Array.isArray((window as any).dataLayer)).toBe(true);
      expect(typeof (window as any).gtag).toBe('function');
      expect(typeof (window as any).ga).toBe('function');
      expect(() => {
        (window as any).gtag('event', 'page_view');
        (window as any).ga('send', 'pageview');
        (window as any).dataLayer.push({ event: 'test' });
      }).not.toThrow();
    });

    it('intercepta HTMLScriptElement.src com URL externa não mapeada e neutraliza como application/blocked', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const script = document.createElement('script');
      script.src = 'https://www.googletagmanager.com/gtag/js?id=G-12345';
      expect(script.getAttribute('type')).toBe('application/blocked');
      expect(script.getAttribute('src')).toBeFalsy();
      expect(warnSpy).toHaveBeenCalledWith(
        '[Pluck Replay Shim] Blocked external unmapped script:',
        'https://www.googletagmanager.com/gtag/js?id=G-12345'
      );
      warnSpy.mockRestore();
    });

    it('bloqueia chamadas fetch de telemetria conhecidas retornando 200 vazio', async () => {
      const res = await window.fetch('/ga/g/c?v=2&tid=G-123');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('');
    });

    it('neutraliza chamadas fetch de prefetch RSC do Next.js retornando 200 text/x-component vazio', async () => {
      const res = await window.fetch('/pricing/__next._tree.txt?_rsc=test1234');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/x-component');
      const text = await res.text();
      expect(text).toBe('');
    });
  });
});
