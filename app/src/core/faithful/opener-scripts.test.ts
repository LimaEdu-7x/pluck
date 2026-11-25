import { describe, it, expect } from 'vitest';
import { generateAbrirBat, generateAbrirPs1, generateAbrirSh, generateReadmeText } from './opener-scripts';

describe('Opener Scripts Security (FIEL-01 & FIEL-07)', () => {
  it('abrir.bat é limpo (3 linhas), sem carets ^, sem $ e chama abrir.ps1', () => {
    const bat = generateAbrirBat();
    expect(bat).not.toContain('^');
    expect(bat).not.toContain('$');
    expect(bat).toContain('abrir.ps1');
    expect(bat).toContain('@echo off');
    expect(bat).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0abrir.ps1"');
  });

  it('abrir.ps1 não contém Access-Control-Allow-Origin: * (FIEL-01)', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).not.toContain("Access-Control-Allow-Origin', '*'");
    expect(ps1).not.toContain('Access-Control-Allow-Origin: *');
  });

  it('abrir.ps1 valida caminho canônico com .StartsWith($baseDir) para prevenir Path Traversal (FIEL-01)', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('$targetPath.StartsWith($baseDir');
    expect(ps1).toContain('403');
  });

  it('abrir.ps1 vincula-se exclusivamente a 127.0.0.1 e usa porta dinâmica livre (FIEL-01 & FIEL-07)', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('127.0.0.1');
    expect(ps1).toContain('TcpListener');
    expect(ps1).toContain('$tcp.LocalEndpoint.Port');
    expect(ps1).not.toContain('$port = 8080');
  });

  it('abrir.sh vincula-se a 127.0.0.1 e usa porta dinâmica (FIEL-01 & FIEL-07)', () => {
    const sh = generateAbrirSh();
    expect(sh).toContain('127.0.0.1');
    expect(sh).toContain('--bind 127.0.0.1');
    expect(sh).not.toContain('http.server 8080 &');
  });

  it('README.txt documenta isolamento em 127.0.0.1 e porta dinâmica', () => {
    const readme = generateReadmeText('Site Teste', 'https://teste.com');
    expect(readme).toContain('127.0.0.1');
    expect(readme).toContain('local');
  });
});
