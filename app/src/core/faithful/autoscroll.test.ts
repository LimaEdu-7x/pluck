import { describe, it, expect, vi, beforeEach } from 'vitest';
import { performAutoscroll } from './autoscroll';

describe('Autoscroll Fiel: Rolagem Passo a Passo e Disparo de Eventos', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div style="height: 2000px;" id="conteudo">
        <button role="tab" id="tab1">Aba 1</button>
        <button role="tab" id="tab2">Aba 2</button>
      </div>
    `;
    window.scrollTo = vi.fn();
    window.dispatchEvent = vi.fn();
  });

  it('rola a página em passos incrementais e despacha WheelEvent para Lenis/GSAP', async () => {
    const wheelEvents: WheelEvent[] = [];
    window.dispatchEvent = vi.fn((e: Event) => {
      if (e.type === 'wheel') {
        wheelEvents.push(e as WheelEvent);
      }
      return true;
    });

    const progressCalls: { currentY: number; maxY: number }[] = [];
    const result = await performAutoscroll({
      step: 500,
      intervalMs: 10,
      maxHeight: 1500,
      initialHeight: 2000,
      onProgress: (cur, max) => progressCalls.push({ currentY: cur, maxY: max })
    });

    expect(result.totalScrolled).toBeGreaterThanOrEqual(1500);
    expect(window.scrollTo).toHaveBeenCalled();
    // Confirma retorno ao topo
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
    expect(wheelEvents.length).toBeGreaterThan(0);
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it('respeita o limite de duração máxima (timeout de segurança)', async () => {
    const result = await performAutoscroll({
      step: 100,
      intervalMs: 50,
      maxHeight: 100000,
      maxDurationMs: 120 // Timeout bem curto
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(100);
    expect(result.totalScrolled).toBeLessThan(100000);
  });
});
