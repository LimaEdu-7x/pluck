// Motor de Autoscroll Fiel (Lenis, GSAP, WheelEvent, Tabs e Lazy-Load)

export interface AutoscrollOptions {
  step?: number;
  intervalMs?: number;
  maxHeight?: number;
  maxDurationMs?: number;
  initialHeight?: number;
  settleDelayMs?: number;
  returnBehavior?: ScrollBehavior;
  passes?: number;
  onProgress?: (currentY: number, maxY: number) => void;
}

export interface AutoscrollResult {
  totalScrolled: number;
  durationMs: number;
  finalHeight: number;
}

export async function performAutoscroll(
  options: AutoscrollOptions = {}
): Promise<AutoscrollResult> {
  const step = options.step || 400;
  const intervalMs = options.intervalMs || 150;
  const maxHeight = options.maxHeight || 60000;
  const maxDurationMs = options.maxDurationMs || 60000;
  const passes = options.passes || 1;
  const startTime = Date.now();

  let currentY = 0;
  let docHeight = getDocumentHeight(options.initialHeight);

  for (let pass = 0; pass < passes; pass++) {
    currentY = 0;
    while (currentY < docHeight && currentY < maxHeight) {
      if (Date.now() - startTime >= maxDurationMs) {
        break;
      }

      currentY += step;
      if (typeof window !== 'undefined') {
        try {
          window.scrollTo({ top: currentY, behavior: 'smooth' });
        } catch {
          if (document.documentElement) document.documentElement.scrollTop = currentY;
        }

        // Dispara WheelEvent sintético para acionar Lenis e GSAP ScrollTrigger
        try {
          window.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: step,
              bubbles: true,
              cancelable: true
            })
          );
        } catch {}

        // Suporte explícito ao Lenis se presente na página
        const win = window as any;
        if (win.lenis && typeof win.lenis.scrollTo === 'function') {
          try {
            win.lenis.scrollTo(currentY, { immediate: false });
          } catch {}
        }
      }

      // Notifica progresso
      if (options.onProgress) {
        options.onProgress(currentY, docHeight);
      }

      // Aguarda o intervalo para o IntersectionObserver e layout responderem
      await sleep(intervalMs);

      // Atualiza a altura caso o site tenha carregado novos blocos dinamicamente
      const newHeight = getDocumentHeight(options.initialHeight);
      if (newHeight > docHeight) {
        docHeight = newHeight;
      }
    }

    if (pass < passes - 1) {
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
      await sleep(500);
    }
  }

  // Interação segura com abas e seletores visíveis na página
  clickSafeInteractiveElements();

  // Retorna ao topo e aguarda acomodação visual completa para reativar animações de entrada do hero
  const settleDelayMs = options.settleDelayMs !== undefined ? options.settleDelayMs : 300;
  const returnBehavior = options.returnBehavior || 'instant';
  if (typeof window !== 'undefined') {
    try {
      window.scrollTo({ top: 0, behavior: returnBehavior });
      const win = window as any;
      if (win.lenis && typeof win.lenis.scrollTo === 'function') {
        try { win.lenis.scrollTo(0, { immediate: returnBehavior === 'instant' }); } catch {}
      }
    } catch {
      if (document.documentElement) document.documentElement.scrollTop = 0;
    }
    await sleep(settleDelayMs);
  }

  return {
    totalScrolled: currentY,
    durationMs: Date.now() - startTime,
    finalHeight: docHeight
  };
}

function getDocumentHeight(fallbackHeight?: number): number {
  if (typeof document === 'undefined') return fallbackHeight || 1000;
  const body = document.body;
  const html = document.documentElement;
  const h = Math.max(
    body ? body.scrollHeight : 0,
    body ? body.offsetHeight : 0,
    html ? html.clientHeight : 0,
    html ? html.scrollHeight : 0,
    html ? html.offsetHeight : 0
  );
  return h > 0 ? h : (fallbackHeight || 1000);
}

function clickSafeInteractiveElements(): void {
  if (typeof document === 'undefined') return;
  try {
    // Seleciona abas, menus e acordeões seguros que não causam navegação
    const tabs = document.querySelectorAll<HTMLElement>(
      '[role="tab"], .tab-link, .tab-button, [data-tab], .accordion-header, .accordion-toggle, .w-nav-button, .menu-button, [data-nav-menu]'
    );
    for (let i = 0; i < Math.min(tabs.length, 12); i++) {
      const el = tabs[i];
      // Ignora links que possuem href para outras páginas
      if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href')?.startsWith('#')) {
        continue;
      }
      try {
        el.click();
      } catch {}
    }
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
