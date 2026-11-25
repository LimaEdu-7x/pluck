// Tipos do Motor de Captura Fiel (CDP + Autoscroll + Reescrita Local + Crawler)

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
}

export interface FaithfulCaptureOptions {
  tabId?: number;
  url: string;
  title?: string;
  html?: string;
  mode?: 'page' | 'linked' | 'site';
  limits?: Partial<CrawlLimits>;
  autoscroll?: boolean;
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
