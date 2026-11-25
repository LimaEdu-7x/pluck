import { zipSync, strToU8 } from 'fflate';

export interface ZipFileEntry {
  path: string;
  content: Uint8Array | string;
}

export interface ZipLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxPerFileBytes: number;
}

export const DEFAULT_PAGE_ZIP_LIMITS: ZipLimits = {
  maxFiles: 300,
  maxTotalBytes: 150 * 1024 * 1024, // 150 MB
  maxPerFileBytes: 25 * 1024 * 1024 // 25 MB
};

export const DEFAULT_IMAGES_ZIP_LIMITS: ZipLimits = {
  maxFiles: 1000,
  maxTotalBytes: 100 * 1024 * 1024, // 100 MB
  maxPerFileBytes: 25 * 1024 * 1024 // 25 MB
};

export interface ZipBuildResult {
  data: Uint8Array;
  fileCount: number;
  totalBytes: number;
  incomplete: boolean;
  skippedFiles: string[];
}

export class ZipBuilder {
  private files: Record<string, Uint8Array> = {};
  private limits: ZipLimits;
  private currentBytes = 0;
  private fileCount = 0;
  private skippedFiles: string[] = [];
  private incomplete = false;

  constructor(limits: ZipLimits = DEFAULT_PAGE_ZIP_LIMITS) {
    this.limits = limits;
  }

  /**
   * [SEC-10] Resolve colisão de nomes adicionando sufixo incremental (-2, -3)
   * sem sobrescrever silenciosamente arquivos existentes.
   */
  private getUniquePath(originalPath: string): string {
    if (!this.files[originalPath]) {
      return originalPath;
    }

    const lastSlash = originalPath.lastIndexOf('/');
    const dir = lastSlash !== -1 ? originalPath.substring(0, lastSlash + 1) : '';
    const filename = lastSlash !== -1 ? originalPath.substring(lastSlash + 1) : originalPath;

    const lastDot = filename.lastIndexOf('.');
    const name = lastDot !== -1 ? filename.substring(0, lastDot) : filename;
    const ext = lastDot !== -1 ? filename.substring(lastDot) : '';

    let counter = 2;
    let candidate = `${dir}${name}-${counter}${ext}`;
    while (this.files[candidate]) {
      counter++;
      candidate = `${dir}${name}-${counter}${ext}`;
    }
    return candidate;
  }

  public addFile(path: string, content: Uint8Array | string): boolean {
    if (this.fileCount >= this.limits.maxFiles) {
      this.incomplete = true;
      this.skippedFiles.push(path);
      return false;
    }

    const u8 = typeof content === 'string' ? strToU8(content) : content;
    const size = u8.byteLength;

    if (size > this.limits.maxPerFileBytes) {
      this.skippedFiles.push(path);
      return false;
    }

    if (this.currentBytes + size > this.limits.maxTotalBytes) {
      this.incomplete = true;
      this.skippedFiles.push(path);
      return false;
    }

    const resolvedPath = this.getUniquePath(path);
    this.files[resolvedPath] = u8;
    this.currentBytes += size;
    this.fileCount++;
    return true;
  }

  public build(): ZipBuildResult {
    const zipped = zipSync(this.files, { level: 6 });
    return {
      data: zipped,
      fileCount: this.fileCount,
      totalBytes: this.currentBytes,
      incomplete: this.incomplete,
      skippedFiles: this.skippedFiles
    };
  }
}
