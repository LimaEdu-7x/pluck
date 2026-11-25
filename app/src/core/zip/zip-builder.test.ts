import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { ZipBuilder } from './zip-builder';

describe('ZipBuilder', () => {
  it('adiciona arquivos e gera ZIP descompactável válido', () => {
    const builder = new ZipBuilder();
    builder.addFile('hello.txt', 'Ola mundo');
    builder.addFile('data/number.bin', new Uint8Array([1, 2, 3, 4]));

    const result = builder.build();
    expect(result.fileCount).toBe(2);
    expect(result.incomplete).toBe(false);
    expect(result.data.length).toBeGreaterThan(0);

    // Descompacta para verificar integridade com fflate
    const unzipped = unzipSync(result.data);
    expect(unzipped['hello.txt']).toBeDefined();
    expect(unzipped['data/number.bin']).toBeDefined();
  });

  it('respeita limite máximo de arquivos', () => {
    const builder = new ZipBuilder({
      maxFiles: 3,
      maxTotalBytes: 1024 * 1024,
      maxPerFileBytes: 1024
    });

    expect(builder.addFile('1.txt', 'a')).toBe(true);
    expect(builder.addFile('2.txt', 'b')).toBe(true);
    expect(builder.addFile('3.txt', 'c')).toBe(true);
    expect(builder.addFile('4.txt', 'd')).toBe(false);

    const result = builder.build();
    expect(result.fileCount).toBe(3);
    expect(result.incomplete).toBe(true);
    expect(result.skippedFiles).toContain('4.txt');
  });

  it('respeita limite de bytes por arquivo e total', () => {
    const builder = new ZipBuilder({
      maxFiles: 10,
      maxTotalBytes: 50,
      maxPerFileBytes: 30
    });

    // Arquivo maior que 30 bytes
    const bigFile = new Uint8Array(35);
    expect(builder.addFile('big.bin', bigFile)).toBe(false);

    // Dois arquivos de 20 bytes (total 40 < 50)
    expect(builder.addFile('ok1.bin', new Uint8Array(20))).toBe(true);
    expect(builder.addFile('ok2.bin', new Uint8Array(20))).toBe(true);

    // Terceiro arquivo estoura limite total de 50
    expect(builder.addFile('overflow.bin', new Uint8Array(20))).toBe(false);

    const result = builder.build();
    expect(result.fileCount).toBe(2);
    expect(result.incomplete).toBe(true);
  });

  it('[SEC-10] evita sobrescrita silenciosa por colisao de caminhos adicionando sufixo (-2, -3)', () => {
    const builder = new ZipBuilder();
    expect(builder.addFile('assets/banner.png', 'primeiro')).toBe(true);
    expect(builder.addFile('assets/banner.png', 'segundo')).toBe(true);
    expect(builder.addFile('assets/banner.png', 'terceiro')).toBe(true);
    expect(builder.addFile('readme', 'doc1')).toBe(true);
    expect(builder.addFile('readme', 'doc2')).toBe(true);

    const result = builder.build();
    expect(result.fileCount).toBe(5);

    const unzipped = unzipSync(result.data);
    expect(unzipped['assets/banner.png']).toBeDefined();
    expect(unzipped['assets/banner-2.png']).toBeDefined();
    expect(unzipped['assets/banner-3.png']).toBeDefined();
    expect(unzipped['readme']).toBeDefined();
    expect(unzipped['readme-2']).toBeDefined();

    const dec = new TextDecoder();
    expect(dec.decode(unzipped['assets/banner.png'])).toBe('primeiro');
    expect(dec.decode(unzipped['assets/banner-2.png'])).toBe('segundo');
    expect(dec.decode(unzipped['assets/banner-3.png'])).toBe('terceiro');
  });
});
