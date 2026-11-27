import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  setState,
  resetToInitialState,
  initSidePanel,
  selectMode
} from './sidepanel';

describe('Correções de TDZ (ReferenceError) e Teclado (Switch Space/Enter)', () => {
  const htmlPath = path.resolve(__dirname, '../../sidepanel.html');
  const fullHtml = fs.readFileSync(htmlPath, 'utf-8');

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = fullHtml;

    (globalThis as any).chrome = {
      runtime: {
        id: 'pluck-test-ext',
        getManifest: () => ({ version: '0.5.0' }),
        sendMessage: vi.fn()
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 10, url: 'https://exemplo.com/pagina', title: 'Página Exemplo', active: true }]),
        get: vi.fn().mockResolvedValue({ id: 10, url: 'https://exemplo.com/pagina', title: 'Página Exemplo', active: true }),
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      windows: {
        getCurrent: vi.fn().mockResolvedValue({ id: 1 }),
        onFocusChanged: { addListener: vi.fn() }
      },
      permissions: {
        contains: vi.fn().mockResolvedValue(true),
        request: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true)
      },
      downloads: {
        download: vi.fn().mockResolvedValue(101),
        showDefaultFolder: vi.fn(),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue({}),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: '<html><body>Conteudo</body></html>' }])
      }
    };

    initSidePanel();
    (window as any).__pluck.setTargetTab({
      tabId: 10,
      url: 'https://exemplo.com/pagina',
      title: 'Página Exemplo',
      html: '<html><body>Conteúdo Exemplo</body></html>'
    });
  });

  afterEach(() => {
    resetToInitialState();
  });

  describe('Item 1: #siteSubdomainsSwitch responde a Space e Enter com preventDefault', () => {
    it('alterna para ligado com Space e para desligado com Enter', () => {
      selectMode('site');
      setState('opcoes', { subview: 'site' });

      const sw = document.getElementById('siteSubdomainsSwitch') as HTMLElement;
      expect(sw).not.toBeNull();
      expect(sw.getAttribute('aria-checked')).toBe('false');
      expect(sw.classList.contains('off')).toBe(true);

      // Aperta Space -> deve ligar
      const spaceEv = new KeyboardEvent('keydown', { key: ' ', cancelable: true, bubbles: true });
      sw.dispatchEvent(spaceEv);
      expect(spaceEv.defaultPrevented).toBe(true);
      expect(sw.getAttribute('aria-checked')).toBe('true');
      expect(sw.classList.contains('off')).toBe(false);

      // Aperta Enter -> deve desligar
      const enterEv = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
      sw.dispatchEvent(enterEv);
      expect(enterEv.defaultPrevented).toBe(true);
      expect(sw.getAttribute('aria-checked')).toBe('false');
      expect(sw.classList.contains('off')).toBe(true);

      // Aperta Space via code: 'Space' -> deve ligar novamente
      const spaceCodeEv = new KeyboardEvent('keydown', { code: 'Space', cancelable: true, bubbles: true });
      sw.dispatchEvent(spaceCodeEv);
      expect(spaceCodeEv.defaultPrevented).toBe(true);
      expect(sw.getAttribute('aria-checked')).toBe('true');
      expect(sw.classList.contains('off')).toBe(false);
    });
  });

  describe('Item 2: Ausência de ReferenceError (TDZ) durante onProgress em captura real', () => {
    it('o código de sidepanel.ts declara let result / let res antes de await em funções com onProgress', () => {
      const sidepanelSource = fs.readFileSync(path.resolve(__dirname, 'sidepanel.ts'), 'utf-8');

      // Verifica ausência de const result = await captureFaithfulSite
      expect(sidepanelSource).not.toMatch(/const\s+result\s*=\s*await\s+captureFaithfulSite/);

      // Verifica ausência de const res = await captureMediaZip
      expect(sidepanelSource).not.toMatch(/const\s+res\s*=\s*await\s+captureMediaZip/);

      // Verifica declaração antecipada let result: any = null
      expect(sidepanelSource).toMatch(/let\s+result:\s*any\s*=\s*null;\s*result\s*=\s*await\s+captureFaithfulSite/);
    });
  });
});
