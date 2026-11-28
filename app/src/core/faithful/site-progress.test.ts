import { describe, it, expect, vi, afterEach } from 'vitest';
import { captureFaithfulSite } from './faithful-engine';

// Site de fixture com fila que cresce: cada página enfileira duas novas (p1 -> p2,p3 ; p2 -> p4,p5 ...)
const ORIGIN = 'https://site.exemplo.com';
const MAX_PAGES = 6;

function pageHtml(n: number): string {
  const links = [n * 2, n * 2 + 1].filter((k) => k > 1 && k < 200).map((k) => `<a href="/p${k}">p${k}</a>`);
  return `<!DOCTYPE html><html><head><title>p${n}</title></head><body>${links.join('')}</body></html>`;
}

describe('progresso de páginas do Site inteiro (fila que cresce)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('concluídas nunca passam do total, total respeita o teto e o último evento bate com a captura', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const m = url.match(/\/p(\d+)$/);
      if (!m) return { ok: false, status: 404, url, text: async () => '' };
      const n = Number(m[1]);
      return { ok: true, status: 200, url, text: async () => pageHtml(n), arrayBuffer: async () => new ArrayBuffer(0) };
    }) as any;

    const events: Array<{ done: number; total: number }> = [];
    const result: any = await captureFaithfulSite({
      url: `${ORIGIN}/`,
      html: pageHtml(1),
      mode: 'site',
      title: 'Site',
      limits: { maxPages: MAX_PAGES, includeSubdomains: false } as any,
      onPages: (done: number, total: number) => events.push({ done, total })
    } as any);

    expect(events.length).toBeGreaterThan(2);

    // 1) concluídas nunca passam do total, em todos os eventos
    for (const e of events) expect(e.done).toBeLessThanOrEqual(e.total);

    // 2) o total só cresce (fila) e nunca passa das páginas aceitas no escopo (teto)
    for (let i = 1; i < events.length; i++) {
      expect(events[i].total).toBeGreaterThanOrEqual(events[i - 1].total);
      expect(events[i].done).toBeGreaterThanOrEqual(events[i - 1].done);
    }
    for (const e of events) expect(e.total).toBeLessThanOrEqual(MAX_PAGES);

    // 3) o total cresceu de fato durante a captura (fila que cresce), não ficou fixo
    const totals = new Set(events.map((e) => e.total));
    expect(totals.size).toBeGreaterThan(2);

    // 4) o último evento é o resultado real: concluídas = total = páginas capturadas
    const last = events[events.length - 1];
    expect(last.done).toBe(last.total);
    expect(last.done).toBe(result.stats.totalPages);
  });

  it('página única: 1 de 1', async () => {
    const events: Array<{ done: number; total: number }> = [];
    await captureFaithfulSite({
      url: `${ORIGIN}/`,
      html: pageHtml(1),
      mode: 'page',
      title: 'Página',
      onPages: (done: number, total: number) => events.push({ done, total })
    } as any);
    expect(events[events.length - 1]).toEqual({ done: 1, total: 1 });
  });
});
