import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { zipFilesProgressive } from './progressive-zip';

function sample(): Record<string, Uint8Array> {
  const bin = new Uint8Array(200 * 1024);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 31 + (i >> 8)) & 255;
  return {
    'index.html': strToU8('<!DOCTYPE html><html><body>Olá, mundo</body></html>'),
    'assets/app.css': strToU8('body{margin:0}'.repeat(500)),
    'assets/app.js': strToU8('console.log(1);'.repeat(300)),
    'img/foto.png': bin,
    'empty.txt': new Uint8Array(0)
  };
}

describe('zipFilesProgressive (ZIP com progresso por arquivo)', () => {
  it('gera um ZIP que abre e tem as mesmas entradas e conteúdo', () => {
    const files = sample();
    const zip = zipFilesProgressive(files);
    const back = unzipSync(zip);
    expect(Object.keys(back).sort()).toEqual(Object.keys(files).sort());
    for (const name of Object.keys(files)) {
      expect(back[name].byteLength).toBe(files[name].byteLength);
      expect(Buffer.from(back[name]).equals(Buffer.from(files[name]))).toBe(true);
    }
  });

  it('emite progresso por arquivo gravado, terminando em total/total', () => {
    const files = sample();
    const calls: Array<[number, number, string]> = [];
    zipFilesProgressive(files, (w, t, n) => calls.push([w, t, n]));
    const total = Object.keys(files).length;
    expect(calls).toHaveLength(total);
    expect(calls.map((c) => c[0])).toEqual([1, 2, 3, 4, 5]);
    expect(calls.every((c) => c[1] === total)).toBe(true);
    expect(calls[calls.length - 1][0]).toBe(total);
    expect(calls.map((c) => c[2])).toEqual(Object.keys(files));
  });

  it('tem o mesmo conteúdo que o zipSync de antes (bytes do contêiner diferem: data descriptors, ~95 B)', () => {
    const files = sample();
    const novo = zipFilesProgressive(files);
    const antigo = zipSync(files, { level: 6 });
    // streaming grava data descriptor por entrada; o zipSync não. Overhead pequeno e fixo por entrada.
    expect(novo.byteLength - antigo.byteLength).toBeGreaterThan(0);
    expect(novo.byteLength - antigo.byteLength).toBeLessThan(16 * Object.keys(files).length + 64);
    const a = unzipSync(novo);
    const b = unzipSync(antigo);
    expect(Object.keys(a)).toEqual(Object.keys(b));
    for (const k of Object.keys(a)) expect(Buffer.from(a[k]).equals(Buffer.from(b[k]))).toBe(true);
  });

  it('pacote vazio gera ZIP válido sem entradas', () => {
    const zip = zipFilesProgressive({});
    expect(Object.keys(unzipSync(zip))).toEqual([]);
  });
});
