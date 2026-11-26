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

  it('respeita o limite por telas (ex: maxScreens: 3 com viewport 800px)', async () => {
    const result = await performAutoscroll({
      step: 400,
      intervalMs: 10,
      initialHeight: 10000,
      viewportHeight: 800,
      limitType: 'screens',
      maxScreens: 3
    });

    expect(result.screensScrolled).toBe(3);
    expect(result.totalScrolled).toBeLessThanOrEqual(3 * 800 + 400);
  });

  it('respeita o limite por tempo em segundos (limitType: time)', async () => {
    const result = await performAutoscroll({
      step: 200,
      intervalMs: 20,
      initialHeight: 50000,
      limitType: 'time',
      maxTimeSeconds: 0.1 // 100 ms
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(80);
    expect(result.totalScrolled).toBeLessThan(50000);
  });

  it('no modo time, não encerra precocemente ao atingir o fundo da página (garante o tempo configurado)', async () => {
    const result = await performAutoscroll({
      step: 400,
      intervalMs: 20,
      initialHeight: 600, // Menor que 2 passos de scroll
      limitType: 'time',
      maxTimeSeconds: 0.2 // 200 ms
    });

    // Deve ter aguardado pelo menos 180 ms no fundo verificando expansão, sem sair precocemente
    expect(result.durationMs).toBeGreaterThanOrEqual(180);
  });

  it('permite parada imediata pelo usuário via shouldStop ou AbortSignal', async () => {
    let callCount = 0;
    const result = await performAutoscroll({
      step: 200,
      intervalMs: 10,
      initialHeight: 10000,
      shouldStop: () => {
        callCount++;
        return callCount >= 3;
      }
    });

    expect(result.stoppedByUser).toBe(true);
    expect(result.totalScrolled).toBeLessThan(2000);
  });

  it('detecta rolagem infinita quando a altura do documento expande dinamicamente', async () => {
    let simulatedHeight = 2000;
    let callCount = 0;

    const result = await performAutoscroll({
      step: 400,
      intervalMs: 10,
      initialHeight: 2000,
      viewportHeight: 800,
      maxScreens: 5,
      getHeight: () => {
        callCount++;
        if (callCount >= 2) {
          simulatedHeight += 1200;
        }
        return simulatedHeight;
      }
    });

    expect(result.isInfiniteScrollDetected).toBe(true);
    expect(result.finalHeight).toBeGreaterThan(2000);
  });
});
