import { describe, it, expect } from 'vitest';
import { generateAbrirPs1, generateAbrirSh } from './opener-scripts';
import { generateReplayShim } from './replay-shim';

describe('loop de login da copia offline', () => {
  it('abrir.ps1 responde /api/* com 404 JSON, nunca com o fallback HTML', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain("StartsWith('api/'");
    expect(ps1).toContain('$res.StatusCode = 404');
    expect(ps1).toContain('application/json');
    // o bloco de API vem antes do fallback HTML
    expect(ps1.indexOf("StartsWith('api/'")).toBeLessThan(ps1.indexOf('offline-fallback.html'));
  });

  it('abrir.ps1 serve /login com o index do app (SPA), sem fallback', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain("$rawPath.TrimEnd('/') -eq 'login'");
    expect(ps1).toContain("Combine($baseDir, 'index.html')");
  });

  it('abrir.sh responde /api/* com 404 JSON e serve /login com index.html', () => {
    const sh = generateAbrirSh();
    expect(sh).toContain("self.path.split('?')[0].startswith('/api/')");
    expect(sh).toContain('self.send_response(404)');
    expect(sh).toContain('json.dumps');
    expect(sh).toContain("== '/login': return os.path.join(os.getcwd(), 'index.html')");
  });

  it('o shim corta o loop: mais de 5 cargas de pagina em 10 s interrompem a navegacao', () => {
    const shim = generateReplayShim({});
    expect(shim).toContain('pluck-doc-loads');
    expect(shim).toContain('loads.length > 5');
    expect(shim).toContain('window.stop()');
    expect(shim).toContain('Redirecionamento interrompido');
  });
});
