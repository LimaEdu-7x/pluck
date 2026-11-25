export interface ResourceItem {
  url: string;
  type: 'image' | 'stylesheet' | 'font' | 'other';
  data?: Uint8Array | string;
  size?: number;
}

export interface ModuleContext {
  tabId?: number;
  url: string;
  title: string;
  html: string;
  resources?: ResourceItem[];
  onProgress?: (loaded: number, total: number, currentItem?: string) => void;
}

export interface AnalyzeItem {
  name: string;
  type: string;
  sizeText?: string;
}

export interface AnalyzeResult {
  moduleId: string;
  totalItems: number;
  items: AnalyzeItem[];
  statusText: string;
}

export interface RunResult {
  moduleId: string;
  filename: string;
  blob: Blob;
  mimeType: string;
  itemCount: number;
  incomplete?: boolean;
}

export interface ExtractionModule {
  id: string;
  title: string;
  description: string;
  badge: string;
  analyze(ctx: ModuleContext): Promise<AnalyzeResult>;
  run(ctx: ModuleContext): Promise<RunResult>;
}
