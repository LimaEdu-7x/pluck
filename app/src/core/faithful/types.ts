// Tipos do Motor de Captura Fiel (CDP + Autoscroll + Reescrita Local + Crawler)
import type { AutoscrollOptions } from './autoscroll';

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

export interface FaithfulCaptureResult {
  filename: string;
  blob: Blob;
  stats: FaithfulCaptureStats;
  files: Record<string, Uint8Array>;
}
