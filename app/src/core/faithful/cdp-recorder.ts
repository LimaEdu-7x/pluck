// Gravador de Rede CDP via chrome.debugger (Captura 100% fiel de tráfego)

import { CapturedResource } from './types';
import { cleanUrlTokens } from '../security/privacy-cleaner';

export const MAX_CDP_RESOURCES = 2000;
export const MAX_CDP_BYTES = 150 * 1024 * 1024; // 150 MB

const SENSITIVE_PATH_REGEX =
  /(\/api\/|\/auth\/|\/token\/|\/oauth\/|\/user\/|\/session\/|\/account\/|\/graphql|\/me(\/|$|\?)|login|logout)/i;

// [FIEL-04] Detecta se um recurso refere-se a dados de API autenticada ou JSON confidencial
export function isSensitiveResource(url: string, mimeType: string): boolean {
  if (!url) return false;

  // 1. Bloqueia qualquer rota de API ou autenticação
  if (SENSITIVE_PATH_REGEX.test(url)) {
    return true;
  }

  // 2. Avalia tipos JSON
  const lowerMime = (mimeType || '').toLowerCase();
  if (
    lowerMime.includes('application/json') ||
    lowerMime.includes('application/ld+json') ||
    lowerMime.includes('text/json')
  ) {
    try {
      const parsed = new URL(url);
      const cleanPath = parsed.pathname.toLowerCase();
      // Permite apenas arquivos estáticos conhecidos (manifest.json, .gltf, .lottie)
      const isStaticAsset =
        cleanPath.endsWith('.json') ||
        cleanPath.endsWith('.gltf') ||
        cleanPath.endsWith('.lottie');

      if (isStaticAsset && !SENSITIVE_PATH_REGEX.test(cleanPath)) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  return false;
}

// [FIEL-04] Remove tokens e parâmetros sensíveis de URLs gravadas em disco/mapas
export function sanitizeUrlForStorage(urlStr: string, pageUrl?: string): string {
  return cleanUrlTokens(urlStr, pageUrl);
}

export interface PendingCdpResponse {
  requestId: string;
  url: string;
  mimeType: string;
  status: number;
  headers?: Record<string, string>;
  isFinished: boolean;
  failed?: boolean;
  receivedAt?: number;
  loaderId?: string;
}

/** Código fixo exposto ao painel quando o Chrome encerra a depuração da aba no meio da captura. */
export const DEBUGGER_DETACHED = 'DEBUGGER_DETACHED' as const;

export class DebuggerDetachedError extends Error {
  readonly code = DEBUGGER_DETACHED;
  /** Motivo do Chrome: 'canceled_by_user' | 'target_closed', ou 'not_attached' quando o detach veio de outro ponto da extensão. */
  readonly reason: string;
  constructor(reason: string) {
    super(`A depuração da aba foi encerrada (${reason}).`);
    this.name = 'PluckDebuggerDetachedError';
    this.reason = reason;
  }
}

export function isDebuggerDetachedError(err: unknown): err is DebuggerDetachedError {
  return (err as { code?: unknown } | null)?.code === DEBUGGER_DETACHED;
}

export class CdpNetworkRecorder {
  private tabId: number;
  private attached = false;
  private responses = new Map<string, PendingCdpResponse>();
  private onEventListener?: (source: chrome.debugger.Debuggee, method: string, params?: any) => void;
  private onDetachListener?: (source: chrome.debugger.Debuggee, reason: string) => void;
  private detachError: DebuggerDetachedError | null = null;
  private frozen = false;
  private documentStatuses = new Map<string, number>();
  private detachCallbacks = new Set<(err: DebuggerDetachedError) => void>();

  private origin = '';

  /** `originUrl` opcional: sem ele, a origem vem da primeira navegação do frame principal (o reload do início). */
  constructor(tabId: number, originUrl?: string) {
    this.tabId = tabId;
    if (originUrl) this.origin = originOfUrl(originUrl);
  }

  public async start(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.debugger) {
      throw new Error('API chrome.debugger não disponível.');
    }

    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
      this.attached = true;
    } catch (err: any) {
      if (err?.message?.includes('Already attached')) {
        this.attached = true;
      } else {
        throw new Error(`Falha ao anexar depurador CDP: ${err?.message || String(err)}`);
      }
    }

    // Configura listeners de eventos do depurador
    this.onEventListener = (source, method, params) => {
      if (source.tabId !== this.tabId) return;

      if (method === 'Network.responseReceived' && params?.response) {
        if (this.frozen) return;
        const { requestId, response } = params;
        if (params.type === 'Document') this.documentStatuses.set(stripHash(response.url), response.status);
        this.responses.set(requestId, {
          requestId,
          url: response.url,
          mimeType: response.mimeType || 'application/octet-stream',
          status: response.status,
          headers: response.headers,
          isFinished: false,
          receivedAt: Date.now(),
          loaderId: params.loaderId
        });
      } else if (method === 'Page.frameNavigated' && params?.frame && !params.frame.parentId) {
        const navOrigin = originOfUrl(params.frame.url || '');
        if (!this.origin) this.origin = navOrigin;
        else if (navOrigin !== this.origin && !this.frozen) {
          // Aba saiu da origem: congela e descarta o documento novo (mesmo loader da navegação)
          this.frozen = true;
          for (const [id, r] of this.responses) {
            if (r.loaderId && r.loaderId === params.frame.loaderId) this.responses.delete(id);
          }
        }
      } else if (method === 'Network.loadingFinished' && params?.requestId) {
        const item = this.responses.get(params.requestId);
        if (item) {
          item.isFinished = true;
        }
      } else if (method === 'Network.loadingFailed' && params?.requestId) {
        const item = this.responses.get(params.requestId);
        if (item) {
          item.failed = true;
        }
      }
    };

    this.onDetachListener = (source, reason) => {
      if (source.tabId === this.tabId) this.markDetached(reason || 'canceled_by_user');
    };

    chrome.debugger.onEvent.addListener(this.onEventListener);
    chrome.debugger.onDetach.addListener(this.onDetachListener);

    // Habilita o domínio Network e Page no CDP
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Network.enable', {
      maxTotalBufferSize: 150 * 1024 * 1024,
      maxResourceBufferSize: 30 * 1024 * 1024
    });
    try {
      await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Page.enable');
    } catch {}
  }

  public async evaluate(expression: string): Promise<any> {
    this.throwIfDetached();
    if (!this.attached || typeof chrome === 'undefined' || !chrome.debugger) {
      return null;
    }
    try {
      const res: any = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true
      });
      return res?.result?.value ?? null;
    } catch (err) {
      this.throwIfDetached();
      console.warn('CdpNetworkRecorder.evaluate falhou:', err);
      return null;
    }
  }

  public async collectResources(
    onProgress?: (loaded: number, total: number, item?: string) => void,
    limits?: { maxBytes?: number }
  ): Promise<CapturedResource[]> {
    this.throwIfDetached();
    // Teto de bytes = limite escolhido pelo usuário (fallback: constante); antes era fixo em 150 MB
    const byteCap = limits?.maxBytes ?? MAX_CDP_BYTES;
    if (!this.attached || typeof chrome === 'undefined' || !chrome.debugger) {
      return [];
    }
    // Sonda barata: um detach feito por outro ponto da extensão não dispara onDetach
    await this.send('Runtime.evaluate', { expression: '1', returnByValue: true }).catch(() => this.throwIfDetached());

    const validRequests = Array.from(this.responses.values()).filter(
      (r) => !r.failed && r.status >= 200 && r.status < 400 && !r.url.startsWith('data:')
    );

    const results: CapturedResource[] = [];
    const collectedUrls = new Set<string>();
    let counter = 0;
    let totalBytesSoFar = 0;
    const total = validRequests.length;

    for (const req of validRequests) {
      counter++;
      if (onProgress) {
        onProgress(counter, total, req.url);
      }

      // [FIEL-04] Bloqueia dados de APIs autenticadas ou payloads confidenciais
      if (isSensitiveResource(req.url, req.mimeType)) {
        continue;
      }

      // [FIEL-06] Teto global de contagem e bytes
      if (results.length >= MAX_CDP_RESOURCES || totalBytesSoFar >= byteCap) {
        console.warn(
          `[CDP Recorder] Limite de segurança atingido (${results.length} recursos, ${totalBytesSoFar} bytes). Interrompendo coleta.`
        );
        break;
      }

      try {
        const bodyObj = (await this.send(
          'Network.getResponseBody',
          { requestId: req.requestId }
        )) as { body: string; base64Encoded: boolean };

        if (bodyObj && bodyObj.body !== undefined) {
          let data: Uint8Array | string;
          if (bodyObj.base64Encoded) {
            data = base64ToUint8(bodyObj.body);
          } else {
            data = bodyObj.body;
          }

          const itemSize = typeof data === 'string' ? data.length : data.byteLength;
          totalBytesSoFar += itemSize;

          // Sanitiza cabeçalhos sensíveis (Set-Cookie / Authorization)
          let sanitizedHeaders: Record<string, string> | undefined = undefined;
          if (req.headers) {
            sanitizedHeaders = {};
            for (const [k, v] of Object.entries(req.headers)) {
              const lower = k.toLowerCase();
              if (lower !== 'set-cookie' && lower !== 'authorization' && lower !== 'cookie') {
                sanitizedHeaders[k] = v;
              }
            }
          }

          collectedUrls.add(req.url);
          results.push({
            url: sanitizeUrlForStorage(req.url),
            mimeType: req.mimeType,
            statusCode: req.status,
            data,
            isBase64: bodyObj.base64Encoded,
            headers: sanitizedHeaders,
            size: itemSize
          });
        }
      } catch {
        this.throwIfDetached();
        // Ignora recursos cujo corpo foi descartado pelo browser ou opaco
      }
    }

    // Coleta adicional de recursos já residentes na árvore da página (Page.getResourceTree).
    // Congelado = a aba já está em outro site: a árvore atual não é mais da página capturada.
    if (this.frozen) return results;
    try {
      const treeRes: any = await this.send('Page.getResourceTree');
      const processFrame = async (frameTree: any) => {
        if (!frameTree) return;
        const frameId = frameTree.frame?.id;
        const resources = frameTree.resources || [];
        for (const res of resources) {
          if (!res.url || res.url.startsWith('data:') || collectedUrls.has(res.url)) continue;
          if (isSensitiveResource(res.url, res.mimeType)) continue;
          if (results.length >= MAX_CDP_RESOURCES || totalBytesSoFar >= byteCap) break;

          try {
            const contentRes: any = await this.send(
              'Page.getResourceContent',
              { frameId, url: res.url }
            );
            if (contentRes && contentRes.content !== undefined) {
              let data: Uint8Array | string;
              if (contentRes.base64Encoded) {
                data = base64ToUint8(contentRes.content);
              } else {
                data = contentRes.content;
              }
              const itemSize = typeof data === 'string' ? data.length : data.byteLength;
              totalBytesSoFar += itemSize;
              collectedUrls.add(res.url);
              results.push({
                url: sanitizeUrlForStorage(res.url),
                mimeType: res.mimeType || 'application/octet-stream',
                statusCode: 200,
                data,
                isBase64: contentRes.base64Encoded,
                size: itemSize
              });
            }
          } catch {
            this.throwIfDetached();
          }
        }
        if (frameTree.childFrames) {
          for (const child of frameTree.childFrames) {
            await processFrame(child);
          }
        }
      };
      await processFrame(treeRes?.frameTree);
    } catch {
      this.throwIfDetached();
      // Page domain pode ser opcional em ambientes sem suporte
    }

    return results;
  }

  public async stop(): Promise<void> {
    this.removeListeners();
    this.detachCallbacks.clear();

    if (this.attached && typeof chrome !== 'undefined' && chrome.debugger) {
      try {
        await chrome.debugger.detach({ tabId: this.tabId });
      } catch {}
      this.attached = false;
    }
  }

  public isAttached(): boolean {
    return this.attached;
  }

  /** Para de aceitar respostas novas (a aba saiu da origem) e descarta as que chegaram depois de `cutoffMs`. */
  public freeze(cutoffMs?: number): void {
    this.frozen = true;
    if (cutoffMs === undefined) return;
    for (const [id, r] of this.responses) {
      if ((r.receivedAt ?? 0) > cutoffMs) this.responses.delete(id);
    }
  }

  /** Status HTTP do documento carregado nesta URL (último visto), ou undefined. */
  public getDocumentStatus(url: string): number | undefined {
    return this.documentStatuses.get(stripHash(url));
  }

  /** Erro de detach, se a depuração foi encerrada pelo Chrome/usuário; senão null. */
  public getDetachError(): DebuggerDetachedError | null {
    return this.detachError;
  }

  public throwIfDetached(): void {
    if (this.detachError) throw this.detachError;
  }

  /** Avisa o painel na hora do detach (para parar a rolagem). Retorna a função para cancelar o aviso. */
  public onDetached(cb: (err: DebuggerDetachedError) => void): () => void {
    if (this.detachError) {
      cb(this.detachError);
      return () => {};
    }
    this.detachCallbacks.add(cb);
    return () => this.detachCallbacks.delete(cb);
  }

  private markDetached(reason: string): void {
    if (this.detachError) return;
    this.attached = false;
    this.detachError = new DebuggerDetachedError(reason);
    this.removeListeners();
    const cbs = [...this.detachCallbacks];
    this.detachCallbacks.clear();
    for (const cb of cbs) {
      try { cb(this.detachError); } catch {}
    }
  }

  private removeListeners(): void {
    if (typeof chrome === 'undefined' || !chrome.debugger) return;
    if (this.onEventListener) chrome.debugger.onEvent?.removeListener(this.onEventListener);
    if (this.onDetachListener) chrome.debugger.onDetach?.removeListener(this.onDetachListener);
    this.onEventListener = undefined;
    this.onDetachListener = undefined;
  }

  private async send(method: string, params?: object): Promise<any> {
    try {
      return await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
    } catch (err: any) {
      if (this.attached && /not attached|detached/i.test(String(err?.message || err))) {
        this.markDetached('not_attached');
      }
      throw err;
    }
  }
}

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

function base64ToUint8(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
