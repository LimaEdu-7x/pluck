// Gravador de Rede CDP via chrome.debugger (Captura 100% fiel de tráfego)

import { CapturedResource } from './types';

export const MAX_CDP_RESOURCES = 2000;
export const MAX_CDP_BYTES = 150 * 1024 * 1024; // 150 MB

const SENSITIVE_PATH_REGEX =
  /(\/api\/|\/auth\/|\/token\/|\/oauth\/|\/user\/|\/session\/|\/account\/|\/graphql|\/me(\/|$|\?)|login|logout)/i;

const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'auth',
  'key',
  'sig',
  'signature',
  'session',
  'session_id',
  'access_token',
  'refresh_token',
  'secret',
  'jwt',
  'password',
  'code',
  'api_key',
  'apikey'
]);

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
export function sanitizeUrlForStorage(urlStr: string): string {
  if (!urlStr || typeof urlStr !== 'string') return urlStr;
  try {
    const parsed = new URL(urlStr);
    let changed = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? parsed.href : urlStr;
  } catch {
    return urlStr;
  }
}

export interface PendingCdpResponse {
  requestId: string;
  url: string;
  mimeType: string;
  status: number;
  headers?: Record<string, string>;
  isFinished: boolean;
  failed?: boolean;
}

export class CdpNetworkRecorder {
  private tabId: number;
  private attached = false;
  private responses = new Map<string, PendingCdpResponse>();
  private onEventListener?: (source: chrome.debugger.Debuggee, method: string, params?: any) => void;
  private onDetachListener?: (source: chrome.debugger.Debuggee, reason: string) => void;

  constructor(tabId: number) {
    this.tabId = tabId;
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
        const { requestId, response } = params;
        this.responses.set(requestId, {
          requestId,
          url: response.url,
          mimeType: response.mimeType || 'application/octet-stream',
          status: response.status,
          headers: response.headers,
          isFinished: false
        });
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

    this.onDetachListener = (source) => {
      if (source.tabId === this.tabId) {
        this.attached = false;
      }
    };

    chrome.debugger.onEvent.addListener(this.onEventListener);
    chrome.debugger.onDetach.addListener(this.onDetachListener);

    // Habilita o domínio Network no CDP
    await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Network.enable', {
      maxTotalBufferSize: 150 * 1024 * 1024,
      maxResourceBufferSize: 30 * 1024 * 1024
    });
  }

  public async collectResources(
    onProgress?: (loaded: number, total: number, item?: string) => void
  ): Promise<CapturedResource[]> {
    if (!this.attached || typeof chrome === 'undefined' || !chrome.debugger) {
      return [];
    }

    const validRequests = Array.from(this.responses.values()).filter(
      (r) => !r.failed && r.status >= 200 && r.status < 400 && !r.url.startsWith('data:')
    );

    const results: CapturedResource[] = [];
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
      if (results.length >= MAX_CDP_RESOURCES || totalBytesSoFar >= MAX_CDP_BYTES) {
        console.warn(
          `[CDP Recorder] Limite de segurança atingido (${results.length} recursos, ${totalBytesSoFar} bytes). Interrompendo coleta.`
        );
        break;
      }

      try {
        const bodyObj = (await chrome.debugger.sendCommand(
          { tabId: this.tabId },
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
        // Ignora recursos cujo corpo foi descartado pelo browser ou opaco
      }
    }

    return results;
  }

  public async stop(): Promise<void> {
    if (this.onEventListener && typeof chrome !== 'undefined' && chrome.debugger?.onEvent) {
      chrome.debugger.onEvent.removeListener(this.onEventListener);
    }
    if (this.onDetachListener && typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
      chrome.debugger.onDetach.removeListener(this.onDetachListener);
    }

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
}

function base64ToUint8(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
