// Tipos do Motor de Captura Fiel (CDP + Autoscroll + Reescrita Local + Crawler)
import type { AutoscrollOptions } from './autoscroll';
import type { TabGuard, TabInterruption } from './tab-guard';

export interface CapturedResource {
  url: string;
  mimeType: string;
  statusCode: number;
  data: Uint8Array | string;
  isBase64?: boolean;
  headers?: Record<string, string>;
  size?: number;
}

export interface CrawlLimits {
  maxPages: number;
  maxBytes: number;
  includeSubdomains: boolean;
  maxDepth?: number;
  allowedExternalDomains?: string[];
}

export interface FaithfulCaptureOptions {
  tabId?: number;
  url: string;
  title?: string;
  html?: string;
  mode?: 'page' | 'linked' | 'site';
  limits?: Partial<CrawlLimits>;
  autoscroll?: boolean;
  autoscrollOptions?: AutoscrollOptions;
  recorder?: any;
  /** Vigia da aba original criado no clique (watchTargetTab). Sem ele, o motor cria um próprio. */
  tabGuard?: TabGuard;
  customResources?: CapturedResource[];
  shouldSkipCurrent?: () => boolean; // SPEC-v12: Pular a página atual durante o crawl
  shouldStop?: () => boolean;        // SPEC-v12: Parar e salvar o que já foi capturado
  signal?: AbortSignal;              // AbortSignal para parada
  onProgress?: (loaded: number, total: number, currentItem?: string) => void;
}

export interface FaithfulCaptureStats {
  totalPages: number;
  totalAssets: number;
  totalBytes: number;
  brokenImages: number;
  externalAssets: number;
  scrolledHeight?: number;
}

export interface FaithfulCaptureWarnings {
  mainStatus?: number;   // HTTP da página principal quando >= 400
  failedPages?: number;  // Site inteiro: páginas com HTTP >= 400 ou erro de rede
  totalPages?: number;   // Site inteiro: páginas tentadas (inclui a principal)
  networkLost?: boolean; // a rede caiu durante o crawl
}

export interface FaithfulCaptureResult {
  filename: string;
  blob: Blob;
  stats: FaithfulCaptureStats;
  files: Record<string, Uint8Array>;
  /** Captura parcial: a aba original fechou ou saiu da origem. O ZIP traz o que já tinha vindo. */
  interrupted?: TabInterruption;
  warnings?: FaithfulCaptureWarnings;
}
