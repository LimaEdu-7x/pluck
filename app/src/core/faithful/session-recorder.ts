// Gerenciador do Modo Gravação Manual do Pluck (SPEC-v12)
// Grava interações sob a página atual; se mudar de página, para e devolve erro com o endereço.

import { CdpNetworkRecorder } from './cdp-recorder';
import { CapturedResource } from './types';

export interface RecordingState {
  isRecording: boolean;
  tabId: number | null;
  startUrl: string;
  normalizedStartUrl: string;
  startTime: number;
  navigatedAway: boolean;
  navigatedToUrl: string | null;
  errorMessage: string | null;
}

export function normalizePageUrlForSession(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    u.hash = ''; // Ignora âncoras/seções na mesma página
    let norm = u.href;
    if (norm.endsWith('/') && u.pathname !== '/') {
      norm = norm.slice(0, -1);
    }
    return norm;
  } catch {
    return urlStr;
  }
}

export function formatNavigationErrorMessage(targetUrl: string): string {
  try {
    const u = new URL(targetUrl);
    const display = `${u.hostname}${u.pathname !== '/' ? u.pathname : ''}`;
    return `A gravação vale só para a página onde começou. Você saiu de ${display}.`;
  } catch {
    return `A gravação vale só para a página onde começou. Você saiu de ${targetUrl}.`;
  }
}

export class SessionRecorder {
  private state: RecordingState = {
    isRecording: false,
    tabId: null,
    startUrl: '',
    normalizedStartUrl: '',
    startTime: 0,
    navigatedAway: false,
    navigatedToUrl: null,
    errorMessage: null
  };

  private recorder: CdpNetworkRecorder | null = null;
  private tabUpdateListener?: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void;
  private onNavigatedAwayCallback?: (errorMsg: string, state: RecordingState) => void;

  public getState(): Readonly<RecordingState> {
    return { ...this.state };
  }

  public isRecording(): boolean {
    return this.state.isRecording && !this.state.navigatedAway;
  }

  public getRecorder(): CdpNetworkRecorder | null {
    return this.recorder;
  }

  /**
   * Inicia gravação manual sob a aba ativa.
   */
  public async start(
    tabId: number,
    startUrl: string,
    onNavigatedAway?: (errorMsg: string, state: RecordingState) => void,
    customRecorder?: CdpNetworkRecorder
  ): Promise<void> {
    this.reset();

    const normalized = normalizePageUrlForSession(startUrl);
    this.state = {
      isRecording: true,
      tabId,
      startUrl,
      normalizedStartUrl: normalized,
      startTime: Date.now(),
      navigatedAway: false,
      navigatedToUrl: null,
      errorMessage: null
    };

    this.onNavigatedAwayCallback = onNavigatedAway;

    // Inicializa gravador CDP
    if (customRecorder) {
      this.recorder = customRecorder;
    } else if (typeof chrome !== 'undefined' && chrome.debugger) {
      this.recorder = new CdpNetworkRecorder(tabId);
      try {
        await this.recorder.start();
      } catch (err) {
        console.warn('[SessionRecorder] Falha ao iniciar chrome.debugger:', err);
        this.recorder = null;
      }
    }

    // Registra listener de navegação da aba
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
      this.tabUpdateListener = (updatedTabId, changeInfo) => {
        if (updatedTabId === this.state.tabId && changeInfo.url) {
          this.handlePotentialNavigation(changeInfo.url);
        }
      };
      chrome.tabs.onUpdated.addListener(this.tabUpdateListener);
    }
  }

  /**
   * Avalia se uma URL representa navegação para fora da página gravada.
   */
  public handlePotentialNavigation(newUrl: string): { allowed: boolean; navigatedAway: boolean; errorMessage?: string } {
    if (!this.state.isRecording) {
      return { allowed: true, navigatedAway: false };
    }

    const normNew = normalizePageUrlForSession(newUrl);
    if (normNew !== this.state.normalizedStartUrl) {
      // O usuário mudou de página! Trava e gera o erro
      this.state.navigatedAway = true;
      this.state.navigatedToUrl = newUrl;
      const errorMsg = formatNavigationErrorMessage(newUrl);
      this.state.errorMessage = errorMsg;

      // Desvincula listener de navegação
      this.cleanupTabListener();

      if (this.onNavigatedAwayCallback) {
        this.onNavigatedAwayCallback(errorMsg, this.state);
      }

      return { allowed: false, navigatedAway: true, errorMessage: errorMsg };
    }

    return { allowed: true, navigatedAway: false };
  }

  /**
   * Para a gravação e retorna os recursos capturados até o momento
   * (usado tanto para parada normal quanto para "Salvar o que já gravei").
   */
  public async stop(): Promise<{
    resources: CapturedResource[];
    durationMs: number;
    navigatedAway: boolean;
    errorMessage: string | null;
  }> {
    this.cleanupTabListener();

    let resources: CapturedResource[] = [];
    if (this.recorder) {
      try {
        resources = await this.recorder.collectResources();
      } catch (e) {
        console.warn('[SessionRecorder] Erro ao coletar recursos:', e);
      }
      try {
        await this.recorder.stop();
      } catch {}
      this.recorder = null;
    }

    const duration = this.state.startTime > 0 ? Date.now() - this.state.startTime : 0;
    const wasNavigatedAway = this.state.navigatedAway;
    const err = this.state.errorMessage;

    this.state.isRecording = false;

    return {
      resources,
      durationMs: duration,
      navigatedAway: wasNavigatedAway,
      errorMessage: err
    };
  }

  /**
   * Reseta o estado para recomeçar uma nova gravação.
   */
  public reset(): void {
    this.cleanupTabListener();
    if (this.recorder) {
      this.recorder.stop().catch(() => {});
      this.recorder = null;
    }
    this.state = {
      isRecording: false,
      tabId: null,
      startUrl: '',
      normalizedStartUrl: '',
      startTime: 0,
      navigatedAway: false,
      navigatedToUrl: null,
      errorMessage: null
    };
  }

  private cleanupTabListener(): void {
    if (this.tabUpdateListener && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
      try {
        chrome.tabs.onUpdated.removeListener(this.tabUpdateListener);
      } catch {}
      this.tabUpdateListener = undefined;
    }
  }
}
