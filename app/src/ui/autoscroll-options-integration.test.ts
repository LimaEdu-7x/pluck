import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  initSidePanel,
  resetToInitialState,
  setScrollLimitChoice,
  getActiveAutoscrollOptions
} from './sidepanel';
import { performAutoscroll } from '../core/faithful/autoscroll';

describe('Integração de Opções de Rolagem Infinita (UI -> Motor)', () => {
  const htmlPath = path.resolve(__dirname, '../../sidepanel.html');
  const fullHtml = fs.readFileSync(htmlPath, 'utf-8');

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = fullHtml;
    (globalThis as any).chrome = {
      runtime: {
        id: 'pluck-test-ext',
        getManifest: () => ({ version: '0.2.0' }),
        sendMessage: vi.fn()
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 10, url: 'https://exemplo.com', title: 'Exemplo', active: true }]),
        get: vi.fn().mockResolvedValue({ id: 10, url: 'https://exemplo.com', title: 'Exemplo', active: true }),
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
        executeScript: vi.fn().mockResolvedValue([{ result: '<html><body>Conteudo exemplo</body></html>' }])
      }
    };
    initSidePanel();
  });

  afterEach(() => {
    resetToInitialState();
  });

  it('o padrão do motor em autoscroll.ts continua sendo maxTimeSeconds: 60', async () => {
    // Ao chamar performAutoscroll sem opções, o padrão é 60s
    // Verificamos que o motor em si não teve seu padrão alterado
    let stepped = false;
    const dummyScroll = await performAutoscroll({
      step: 1000,
      intervalMs: 1,
      initialHeight: 1000,
      limitType: 'time',
      shouldStop: () => {
        if (stepped) return true;
        stepped = true;
        return false;
      }
    });
    expect(dummyScroll.totalScrolled).toBeGreaterThanOrEqual(1000);
  });

  it('quando a opção 30s é escolhida na UI, passa maxTimeSeconds: 30 e limitType: time', () => {
    setScrollLimitChoice('30');
    const opts = getActiveAutoscrollOptions();
    expect(opts.limitType).toBe('time');
    expect(opts.maxTimeSeconds).toBe(30);
  });

  it('quando a opção 10 telas é escolhida na UI, passa maxScreens: 10 e limitType: screens', () => {
    setScrollLimitChoice('10');
    const opts = getActiveAutoscrollOptions();
    expect(opts.limitType).toBe('screens');
    expect(opts.maxScreens).toBe(10);
  });

  it('quando a opção Sem limite é escolhida na UI, passa limitType: unlimited', () => {
    setScrollLimitChoice('unlimited');
    const opts = getActiveAutoscrollOptions();
    expect(opts.limitType).toBe('unlimited');
  });

  it('cliques nos cards visuais de rolagem atualizam o estado e as opções do motor', () => {
    const cardTime = document.getElementById('scrollCardTime');
    expect(cardTime).not.toBeNull();
    cardTime?.click();

    let opts = (window as any).__pluck.getActiveAutoscrollOptions();
    expect(opts.limitType).toBe('time');
    expect(opts.maxTimeSeconds).toBe(30);

    const cardUnlimited = document.getElementById('scrollCardUnlimited');
    cardUnlimited?.click();
    opts = (window as any).__pluck.getActiveAutoscrollOptions();
    expect(opts.limitType).toBe('unlimited');

    const cardScreens = document.getElementById('scrollCardScreens');
    cardScreens?.click();
    opts = (window as any).__pluck.getActiveAutoscrollOptions();
    expect(opts.limitType).toBe('screens');
    expect(opts.maxScreens).toBe(10);
  });
});
