import { describe, it, expect, vi, afterEach } from 'vitest';
import { CdpNetworkRecorder, DEBUGGER_DETACHED, isDebuggerDetachedError } from './cdp-recorder';
import { captureFaithfulSite } from './faithful-engine';

// Mock mínimo de chrome.debugger com onDetach disparável pelo teste
function mockChrome(sendCommand: (...a: any[]) => Promise<any> = vi.fn(async () => ({}))) {
  const detach: Array<(s: any, r: string) => void> = [];
  const events: Array<(...a: any[]) => void> = [];
  (globalThis as any).chrome = {
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand,
      onEvent: { addListener: (f: any) => events.push(f), removeListener: (f: any) => events.splice(events.indexOf(f), 1) },
      onDetach: { addListener: (f: any) => detach.push(f), removeListener: (f: any) => detach.splice(detach.indexOf(f), 1) }
    }
  };
  return { detach, events, fireDetach: (tabId: number, reason: string) => [...detach].forEach((f) => f({ tabId }, reason)) };
}

describe('B2: debugger desconectado durante a captura', () => {
  afterEach(() => { delete (globalThis as any).chrome; });

  it('onDetach da aba alvo gera DEBUGGER_DETACHED, avisa o painel e limpa listeners', async () => {
    const m = mockChrome();
    const rec = new CdpNetworkRecorder(7);
    await rec.start();
    const seen: any[] = [];
    rec.onDetached((e) => seen.push(e));
    m.fireDetach(99, 'canceled_by_user'); // outra aba: ignora
    expect(rec.getDetachError()).toBeNull();
    m.fireDetach(7, 'canceled_by_user');
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe(DEBUGGER_DETACHED);
    expect(seen[0].reason).toBe('canceled_by_user');
    expect(m.detach).toHaveLength(0);
    expect(m.events).toHaveLength(0);
    await expect(rec.evaluate('1')).rejects.toMatchObject({ code: DEBUGGER_DETACHED });
    await expect(rec.collectResources()).rejects.toMatchObject({ code: DEBUGGER_DETACHED });
  });

  it('detach feito por outro ponto da extensão (sem onDetach) é detectado na coleta', async () => {
    const send = vi.fn(async (_t: any, method: string) => {
      if (method === 'Network.enable' || method === 'Page.enable') return {};
      throw new Error('Debugger is not attached to the tab with id: 7.');
    });
    mockChrome(send);
    const rec = new CdpNetworkRecorder(7);
    await rec.start();
    const err = await rec.collectResources().catch((e) => e);
    expect(isDebuggerDetachedError(err)).toBe(true);
    expect(err.reason).toBe('not_attached');
  });

  it('captureFaithfulSite rejeita (não gera ZIP) se a depuração caiu antes', async () => {
    const m = mockChrome();
    const rec = new CdpNetworkRecorder(7);
    await rec.start();
    m.fireDetach(7, 'target_closed');
    await expect(
      captureFaithfulSite({ url: 'https://exemplo.com/', html: '<html><body>x</body></html>', recorder: rec, autoscroll: false } as any)
    ).rejects.toMatchObject({ code: DEBUGGER_DETACHED, reason: 'target_closed' });
  });
});
