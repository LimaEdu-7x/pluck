import { describe, it, expect } from 'vitest';
import { generateAbrirBat, generateAbrirSh, generateReadmeText } from './opener-scripts';

describe('Opener Scripts Security (FIEL-01 & FIEL-07)', () => {
  it('abrir.bat não contém Access-Control-Allow-Origin: * (FIEL-01)', () => {
    const bat = generateAbrirBat();
    expect(bat).not.toContain("Access-Control-Allow-Origin', '*'");
    expect(bat).not.toContain('Access-Control-Allow-Origin: *');
  });

  it('abrir.bat valida caminho canônico com .StartsWith($dir) para prevenir Path Traversal (FIEL-01)', () => {
    const bat = generateAbrirBat();
    expect(bat).toContain('$fullPath.StartsWith($dir');
    expect(bat).toContain('403');
  });

  it('abrir.bat vincula-se exclusivamente a 127.0.0.1 e usa porta dinâmica livre (FIEL-01 & FIEL-07)', () => {
    const bat = generateAbrirBat();
    expect(bat).toContain('127.0.0.1');
    expect(bat).toContain('TcpListener');
    expect(bat).toContain('$tcpListener.LocalEndpoint.Port');
    // Não pode estar travado na porta fixa 8080
    expect(bat).not.toContain('$port = 8080;');
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
