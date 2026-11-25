import { describe, it, expect } from 'vitest';
import { safePath } from './safe-path';

describe('SafePath', () => {
  it('elimina tentativas de travessia de diretório', () => {
    expect(safePath('../../etc/passwd')).toBe('etc_passwd');
    expect(safePath('..\\..\\windows\\system32')).toBe('windows_system32');
    expect(safePath('folder/../../../secret.txt')).toBe('folder_secret.txt');
  });

  it('remove bytes nulos e caracteres de controle', () => {
    expect(safePath('arquivo\0malicioso.txt')).toBe('arquivomalicioso.txt');
    expect(safePath('teste\x01\x1F.png')).toBe('teste.png');
  });

  it('protege contra nomes de dispositivo reservados do Windows', () => {
    expect(safePath('CON.txt')).toBe('_CON.txt');
    expect(safePath('nul')).toBe('_nul');
    expect(safePath('aux.html')).toBe('_aux.html');
    expect(safePath('com1.json')).toBe('_com1.json');
  });

  it('elimina caracteres especiais de injeção e direção unicode (U+202E)', () => {
    // RTL override: U+202E
    const rtl = 'relatorio\u202Egnp.exe';
    const result = safePath(rtl);
    expect(result).not.toContain('\u202E');
  });

  it('trunca nomes excessivamente longos preservando extensão', () => {
    const longName = 'a'.repeat(150) + '.html';
    const result = safePath(longName);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith('.html')).toBe(true);
  });

  it('usa fallback para entradas vazias', () => {
    expect(safePath('')).toBe('download');
    expect(safePath('...')).toBe('download');
  });

  it('[SEC-08] protege contra dispositivos especiais de console do Windows (CONIN$, CONOUT$, COM0, LPT0)', () => {
    expect(safePath('CONIN$')).toBe('_CONIN$');
    expect(safePath('conin$')).toBe('_conin$');
    expect(safePath('CONOUT$')).toBe('_CONOUT$');
    expect(safePath('conout$')).toBe('_conout$');
    expect(safePath('COM0')).toBe('_COM0');
    expect(safePath('com0.dat')).toBe('_com0.dat');
    expect(safePath('LPT0')).toBe('_LPT0');
    expect(safePath('lpt0.txt')).toBe('_lpt0.txt');
    // Contorno encontrado pelo Cofre: espaços antes do ponto
    expect(safePath('CON .txt')).toBe('_CON .txt');
    expect(safePath('con   .html')).toBe('_con   .html');
    expect(safePath('aux .png')).toBe('_aux .png');
  });

  it('[SEC-09] decodifica sequencias de escape URL (%2e%2e%2f, %2f, %5c) antes da checagem de travessia', () => {
    expect(safePath('..%2f..%2fpasswd')).toBe('passwd');
    expect(safePath('folder%2f..%2f..%2fsecret.txt')).toBe('folder_secret.txt');
    expect(safePath('..%5c..%5cwindows%5csystem32')).toBe('windows_system32');
    expect(safePath('%2e%2e%2f%2e%2e%2fetc%2fshadow')).toBe('etc_shadow');
    // Contorno encontrado pelo Cofre: dupla e tripla codificação
    expect(safePath('%252e%252e%252fpasswd')).toBe('passwd');
    expect(safePath('%25252e%25252e%25252fetc%25252fshadow')).toBe('etc_shadow');
  });

  it('[SEC-14] descarta query params e hash evitando truncamento incorreto de extensao', () => {
    expect(safePath('imagem.png?v=1.2')).toBe('imagem.png');
    expect(safePath('foto.jpg#secao')).toBe('foto.jpg');
    expect(safePath('script.js?v=2.0.1&auth=xyz')).toBe('script.js');
  });
});
