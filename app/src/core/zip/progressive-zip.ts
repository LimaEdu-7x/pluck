import { Zip, ZipDeflate } from 'fflate';

export type ZipProgress = (written: number, total: number, name: string) => void;

// Monta o ZIP arquivo a arquivo (mesmo nível 6 do zipSync) e avisa cada arquivo gravado.
// Mesmo resultado do zipSync(files, { level: 6 }): mesmas entradas, mesmo conteúdo e mesma ordem.
export function zipFilesProgressive(
  files: Record<string, Uint8Array>,
  onProgress?: ZipProgress
): Uint8Array {
  const names = Object.keys(files);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    chunks.push(chunk);
    size += chunk.byteLength;
  });
  names.forEach((name, i) => {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(files[name], true);
    onProgress?.(i + 1, names.length, name);
  });
  zip.end();

  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
