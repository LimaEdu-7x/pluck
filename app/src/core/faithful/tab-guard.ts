// Prende a captura à aba original: fechar a aba ou sair da origem interrompe; trocar de aba ativa não afeta.
export type TabInterruption = 'tab_closed' | 'navigated_away';

export interface TabGuard {
  readonly reason: TabInterruption | null;
  /** Date.now() da interrupção, para descartar o que chegou depois dela. */
  readonly interruptedAt: number | undefined;
  /** Chamado uma vez na interrupção (ou na hora, se já interrompida). Retorna a função para desinscrever. */
  onInterrupted(cb: (reason: TabInterruption) => void): () => void;
  /** Marca a interrupção por fora (ex.: debugger caiu com target_closed). */
  interrupt(reason: TabInterruption): void;
  stop(): void;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function watchTargetTab(tabId: number, originalUrl: string): TabGuard {
  const origin = originOf(originalUrl);
  const callbacks = new Set<(reason: TabInterruption) => void>();
  let reason: TabInterruption | null = null;
  let interruptedAt: number | undefined;
  const tabs = typeof chrome !== 'undefined' ? chrome.tabs : undefined;

  const onRemoved = (removedId: number) => {
    if (removedId === tabId) guard.interrupt('tab_closed');
  };
  const onUpdated = (updatedId: number, change: chrome.tabs.TabChangeInfo) => {
    if (updatedId !== tabId || !change.url) return;
    // about:blank/chrome-error transitórios também saem da origem: contam como navegação para fora
    if (originOf(change.url) !== origin) guard.interrupt('navigated_away');
  };

  const guard: TabGuard = {
    get reason() {
      return reason;
    },
    get interruptedAt() {
      return interruptedAt;
    },
    onInterrupted(cb) {
      if (reason) {
        cb(reason);
        return () => {};
      }
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    interrupt(r) {
      if (reason) return;
      reason = r;
      interruptedAt = Date.now();
      guard.stop();
      const cbs = [...callbacks];
      callbacks.clear();
      for (const cb of cbs) {
        try { cb(r); } catch {}
      }
    },
    stop() {
      tabs?.onRemoved?.removeListener(onRemoved);
      tabs?.onUpdated?.removeListener(onUpdated);
    }
  };

  tabs?.onRemoved?.addListener(onRemoved);
  tabs?.onUpdated?.addListener(onUpdated);
  return guard;
}
