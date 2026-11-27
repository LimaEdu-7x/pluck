import { describe, it, expect, vi, afterEach } from 'vitest';
import { CdpNetworkRecorder, DEBUGGER_DETACHED } from './cdp-recorder';
import { captureFaithfulSite } from './faithful-engine';
import { watchTargetTab } from './tab-guard';

const HTML = '<!DOCTYPE html><html><head><title>t</title></head><body><a href="/b">b</a><a href="/c">c</a><p>ok</p></body></html>';

function ev() {
  const fns: Array<(...a: any[]) => void> = [];
  return { fns, addListener: (f: any) => fns.push(f), removeListener: (f: any) => fns.splice(fns.indexOf(f), 1), fire: (...a: any[]) => [...fns].forEach((f) => f(...a)) };
}

function mockChrome() {
  const onEvent = ev(), onDetach = ev(), onRemoved = ev(), onUpdated = ev();
  (globalThis as any).chrome = {
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_t: any, method: string, params: any) => {
        if (method === 'Network.getResponseBody') return { body: `corpo-${params.requestId}`, base64Encoded: false };
        if (method === 'Page.getResourceTree') return { frameTree: { frame: { id: 'f' }, resources: [{ url: 'https://example.com/arvore-atual.js', mimeType: 'text/javascript' }] } };
        if (method === 'Page.getResourceContent') return { content: 'x', base64Encoded: false };
        return {};
      }),
      onEvent,
      onDetach
    },
    tabs: { onRemoved, onUpdated }
  };
  const resp = (id: string, url: string, status = 200, type = 'Image') =>
    onEvent.fire({ tabId: 7 }, 'Network.responseReceived', { requestId: id, type, response: { url, status, mimeType: type === 'Document' ? 'text/html' : 'image/png', headers: {} } });
  return { onEvent, onDetach, onRemoved, onUpdated, resp };
}

afterEach(() => {
  delete (globalThis as any).chrome;
  vi.restoreAllMocks();
});

describe('C: captura presa à aba original', () => {
  it('tab-guard: trocar de aba ativa ou navegar na mesma origem não interrompe; outra origem e fechar interrompem', () => {
    const m = mockChrome();
    const g = watchTargetTab(7, 'https://exemplo.com/a');
    m.onUpdated.fire(8, { url: 'https://example.com/' }); // outra aba
    m.onUpdated.fire(7, { url: 'https://exemplo.com/outra-rota' });
    m.onUpdated.fire(7, { status: 'loading' });
    expect(g.reason).toBeNull();
    m.onUpdated.fire(7, { url: 'https://example.com/' });
    expect(g.reason).toBe('navigated_away');
    expect(m.onUpdated.fns).toHaveLength(0);
    const g2 = watchTargetTab(7, 'https://exemplo.com/');
    m.onRemoved.fire(8);
    expect(g2.reason).toBeNull();
    m.onRemoved.fire(7);
    expect(g2.reason).toBe('tab_closed');
  });

  it('navegar para outra origem: devolve parcial com interrupted e sem recursos do site novo', async () => {
    const m = mockChrome();
    const rec = new CdpNetworkRecorder(7);
    await rec.start();
    const guard = watchTargetTab(7, 'https://exemplo.com/');
    const nav = (url: string, loaderId: string) => m.onEvent.fire({ tabId: 7 }, 'Page.frameNavigated', { frame: { id: 'top', url, loaderId } });
    nav('https://exemplo.com/', 'L1'); // reload do início fixa a origem
    m.resp('r1', 'https://exemplo.com/logo.png');
    m.onEvent.fire({ tabId: 7 }, 'Network.responseReceived', { requestId: 'd2', loaderId: 'L2', type: 'Document', response: { url: 'https://example.com/', status: 200, mimeType: 'text/html', headers: {} } });
    nav('https://example.com/', 'L2');
    m.onUpdated.fire(7, { url: 'https://example.com/' });
    m.resp('r2', 'https://example.com/intruso.png');
    globalThis.fetch = vi.fn(async () => { throw new TypeError('sem rede no teste'); }) as any;
    const res = await captureFaithfulSite({ tabId: 7, url: 'https://exemplo.com/', html: HTML, recorder: rec, tabGuard: guard, autoscroll: false });
    expect(res.interrupted).toBe('navigated_away');
    const nomes = Object.keys(res.files).join(' ');
    expect(nomes).toContain('logo.png');
    expect(nomes).not.toContain('intruso');
    expect(nomes).not.toContain('example.com');
    expect(res.files['index.html']).toBeDefined();
  });

  it('aba fechada (debugger cai com target_closed): parcial com tab_closed, não DEBUGGER_DETACHED', async () => {
    const m = mockChrome();
    const rec = new CdpNetworkRecorder(7);
    await rec.start();
    m.onDetach.fire({ tabId: 7 }, 'target_closed');
    globalThis.fetch = vi.fn(async () => { throw new TypeError('x'); }) as any;
    const res = await captureFaithfulSite({ tabId: 7, url: 'https://exemplo.com/', html: HTML, recorder: rec, autoscroll: false });
    expect(res.interrupted).toBe('tab_closed');
    expect(res.files['index.html']).toBeDefined();
  });

  it('usuário cancela a depuração: continua rejeitando com DEBUGGER_DETACHED', async () => {
    const m = mockChrome();
    const rec = new CdpNetworkRecorder(7);
    await rec.start();
    m.onDetach.fire({ tabId: 7 }, 'canceled_by_user');
    await expect(captureFaithfulSite({ tabId: 7, url: 'https://exemplo.com/', html: HTML, recorder: rec, autoscroll: false }))
      .rejects.toMatchObject({ code: DEBUGGER_DETACHED });
  });
});

describe('F: salvar e avisar', () => {
  it('página principal 404: salva e reporta mainStatus', async () => {
    const m = mockChrome();
    const rec = new CdpNetworkRecorder(7);
    await rec.start();
    m.resp('doc', 'https://exemplo.com/#topo', 404, 'Document');
    globalThis.fetch = vi.fn(async () => { throw new TypeError('x'); }) as any;
    const res = await captureFaithfulSite({ tabId: 7, url: 'https://exemplo.com/', html: HTML, recorder: rec, autoscroll: false });
    expect(res.warnings?.mainStatus).toBe(404);
    expect(res.files['index.html']).toBeDefined();
    expect(res.interrupted).toBeUndefined();
  });

  it('página 200 sem falhas: sem warnings', async () => {
    const m = mockChrome();
    const rec = new CdpNetworkRecorder(7);
    await rec.start();
    m.resp('doc', 'https://exemplo.com/', 200, 'Document');
    const res = await captureFaithfulSite({ tabId: 7, url: 'https://exemplo.com/', html: HTML, recorder: rec, autoscroll: false });
    expect(res.warnings).toBeUndefined();
  });

  it('Site inteiro: conta páginas com HTTP >= 400 e queda de rede', async () => {
    globalThis.fetch = vi.fn(async (u: any) => {
      const url = String(u);
      if (url.endsWith('/b')) return new Response('erro', { status: 500 });
      if (url.endsWith('/c')) throw new TypeError('Failed to fetch');
      throw new TypeError('x');
    }) as any;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const res = await captureFaithfulSite({ url: 'https://exemplo.com/', html: HTML, mode: 'site', autoscroll: false });
    expect(res.warnings).toMatchObject({ failedPages: 2, totalPages: 3, networkLost: true });
    expect(res.files['index.html']).toBeDefined();
  });
});

describe('C no caminho do crawler (Site inteiro / páginas vinculadas)', () => {
  const site = (n: number) =>
    `<!DOCTYPE html><html><head><title>p</title></head><body>${Array.from({ length: n }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('')}</body></html>`;

  it('navegar para outra origem no meio do crawl: para, navigated_away e só páginas da origem original', async () => {
    const m = mockChrome();
    const guard = watchTargetTab(7, 'https://exemplo.com/');
    const buscadas: string[] = [];
    globalThis.fetch = vi.fn(async (u: any) => {
      const url = String(u);
      buscadas.push(url);
      if (url.endsWith('/p1')) m.onUpdated.fire(7, { url: 'https://example.com/' }); // aba sai no meio
      return new Response(`<html><head><title>${url}</title></head><body>ok</body></html>`, { headers: { 'content-type': 'text/html' } });
    }) as any;
    const res = await captureFaithfulSite({ tabId: 7, url: 'https://exemplo.com/', html: site(5), mode: 'site', tabGuard: guard, autoscroll: false });
    expect(res.interrupted).toBe('navigated_away');
    const paginas = Object.keys(res.files).filter((f) => f.endsWith('.html'));
    expect(paginas.join(' ')).not.toContain('example');
    expect(buscadas.some((u) => u.includes('/p3'))).toBe(false); // parou de buscar
    expect(res.files['p0.html'] ?? res.files['p0/index.html']).toBeDefined(); // antes de sair: entra
    expect(res.files['p1.html'] ?? res.files['p1/index.html']).toBeUndefined(); // baixada após sair: não entra
  });

  it('fechar a aba durante um fetch lento do crawler: cancela, devolve parcial tab_closed sem ficar pendurado', async () => {
    const m = mockChrome();
    const guard = watchTargetTab(7, 'https://exemplo.com/');
    globalThis.fetch = vi.fn((u: any, init?: RequestInit) => {
      if (String(u).endsWith('/p0')) {
        setTimeout(() => m.onRemoved.fire(7), 20);
        // nunca responde: só termina se o motor abortar
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))));
      }
      return Promise.resolve(new Response('<html><body>x</body></html>', { headers: { 'content-type': 'text/html' } }));
    }) as any;
    const t0 = Date.now();
    const res = await captureFaithfulSite({ tabId: 7, url: 'https://exemplo.com/', html: site(3), mode: 'linked', tabGuard: guard, autoscroll: false });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.interrupted).toBe('tab_closed');
    expect(res.files['index.html']).toBeDefined();
    expect(res.warnings?.failedPages).toBeUndefined(); // abort por interrupção não conta como falha
  });

  it('DOM lido de outro site (carimbo de origem diferente): descarta e usa o HTML original da origem certa', async () => {
    mockChrome();
    const guard = watchTargetTab(7, 'https://exemplo.com/');
    globalThis.fetch = vi.fn(async (u: any) => {
      if (String(u) === 'https://exemplo.com/') return new Response('<!DOCTYPE html><html><head><title>Original</title></head><body>original</body></html>', { headers: { 'content-type': 'text/html' } });
      throw new TypeError('x');
    }) as any;
    const htmlErrado = '<!DOCTYPE html><html><head><title>Example Domain</title></head><body>example</body></html><!--pluck-source-origin:https://example.com-->';
    const res = await captureFaithfulSite({ tabId: 7, url: 'https://exemplo.com/', html: htmlErrado, mode: 'site', tabGuard: guard, autoscroll: false });
    expect(res.interrupted).toBe('navigated_away');
    const index = new TextDecoder().decode(res.files['index.html']);
    expect(index).toContain('Original');
    expect(index).not.toContain('Example Domain');
    expect(index).not.toContain('pluck-source-origin');
  });
});
