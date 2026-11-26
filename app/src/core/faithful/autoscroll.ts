// Motor de Autoscroll Fiel (Lenis, GSAP, WheelEvent, Tabs, Lazy-Load e Rolagem Infinita)

export type InfiniteScrollLimitType = 'screens' | 'time' | 'unlimited';

export interface AutoscrollProgressInfo {
  screensScrolled: number;
  isInfiniteScroll: boolean;
  docHeight: number;
  currentY: number;
}

export interface AutoscrollOptions {
  step?: number;
  intervalMs?: number;
  maxHeight?: number;
  maxDurationMs?: number;
  initialHeight?: number;
  settleDelayMs?: number;
  returnBehavior?: ScrollBehavior;
  passes?: number;
  onProgress?: (currentY: number, maxY: number, info?: AutoscrollProgressInfo) => void;

  // SPEC-v12: Rolagem Infinita e Limites
  limitType?: InfiniteScrollLimitType; // 'screens' (padrão) | 'time' | 'unlimited'
  maxScreens?: number;                 // padrão: 10 telas
  maxTimeSeconds?: number;             // padrão: 60 s
  viewportHeight?: number;             // altura da tela (padrão: window.innerHeight || 800)
  getHeight?: () => number;            // getter customizado de altura (suporte a containers virtuais/testes)
  shouldStop?: () => boolean;          // callback para parada imediata pelo usuário ("Parar e salvar" ou "Pular")
  signal?: AbortSignal;                // AbortSignal para cancelamento
}

export interface AutoscrollResult {
  totalScrolled: number;
  durationMs: number;
  finalHeight: number;
  screensScrolled: number;
  isInfiniteScrollDetected: boolean;
  stoppedByUser: boolean;
}

export async function performAutoscroll(
  options: AutoscrollOptions = {}
): Promise<AutoscrollResult> {
  const step = options.step || 400;
  const intervalMs = options.intervalMs || 150;
  const passes = options.passes || 1;
  const startTime = Date.now();

  const limitType: InfiniteScrollLimitType = options.limitType || 'screens';
  const maxScreens = options.maxScreens !== undefined ? options.maxScreens : 10;
  const maxTimeSeconds = options.maxTimeSeconds !== undefined ? options.maxTimeSeconds : 60;

  // Limite de tempo em ms
  const maxDurationMs =
    limitType === 'time'
      ? maxTimeSeconds * 1000
      : (options.maxDurationMs || (limitType === 'unlimited' ? 3600000 : maxTimeSeconds * 1000));

  const viewportHeight =
    options.viewportHeight ||
    (typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800);

  const maxHeight = limitType === 'unlimited' ? 1000000 : (options.maxHeight || 60000);

  let currentY = 0;
  const initialDocHeight = getDocumentHeight(options.initialHeight, options.getHeight);
  let docHeight = initialDocHeight;
  let heightExpansions = 0;
  let isInfiniteScrollDetected = false;
  let stoppedByUser = false;

  for (let pass = 0; pass < passes; pass++) {
    currentY = 0;
    while (
      (limitType === 'time' || currentY < docHeight) &&
      (limitType === 'time' || currentY < maxHeight)
    ) {
      // Checa parada solicitada pelo usuário
      if ((options.shouldStop && options.shouldStop()) || options.signal?.aborted) {
        stoppedByUser = true;
        break;
      }

      // Checa limite de tempo
      if (Date.now() - startTime >= maxDurationMs) {
        break;
      }

      // Checa limite por telas no modo 'screens'
      const currentScreens = Math.floor(currentY / viewportHeight);
      if (limitType === 'screens' && currentScreens >= maxScreens) {
        break;
      }

      // Se não for por tempo e já atingiu o final do documento, encerra o loop
      if (limitType !== 'time' && currentY >= docHeight) {
        break;
      }

      // Avança o scroll até a altura máxima conhecida
      if (currentY < docHeight) {
        currentY = Math.min(docHeight, currentY + step);
      }
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

      // Notifica progresso com métricas detalhadas
      if (options.onProgress) {
        options.onProgress(currentY, docHeight, {
          screensScrolled: Math.floor(currentY / viewportHeight),
          isInfiniteScroll: isInfiniteScrollDetected,
          docHeight,
          currentY
        });
      }

      // Aguarda o intervalo para o IntersectionObserver e layout responderem
      await sleep(intervalMs);

      // Checa parada durante o sleep
      if ((options.shouldStop && options.shouldStop()) || options.signal?.aborted) {
        stoppedByUser = true;
        break;
      }

      // Atualiza a altura caso o site tenha carregado novos blocos dinamicamente (rolagem infinita)
      const newHeight = getDocumentHeight(options.initialHeight, options.getHeight);
      if (newHeight > docHeight) {
        heightExpansions++;
        if (heightExpansions >= 2 || newHeight > initialDocHeight + viewportHeight) {
          isInfiniteScrollDetected = true;
        }
        docHeight = newHeight;
      }
    }

    if (stoppedByUser) {
      break;
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

  const finalScreens = Math.floor(currentY / viewportHeight);

  return {
    totalScrolled: currentY,
    durationMs: Date.now() - startTime,
    finalHeight: docHeight,
    screensScrolled: finalScreens,
    isInfiniteScrollDetected,
    stoppedByUser
  };
}

function getDocumentHeight(fallbackHeight?: number, customGetter?: () => number): number {
  if (customGetter) {
    try {
      const val = customGetter();
      if (typeof val === 'number' && val > 0) return val;
    } catch {}
  }
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
      // Ignora chips e filtros dinâmicos de feeds como YouTube que interrompem ou resetam o grid
      if (el.closest('yt-chip-cloud-chip-renderer, ytd-feed-filter-chip-bar-renderer, [class*="chip"]')) {
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
