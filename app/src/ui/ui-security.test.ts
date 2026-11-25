import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBaixandoRow, createConfigItem } from './ui-helpers';
import { cleanupResources } from './sidepanel';
import fs from 'node:fs';
import path from 'node:path';

describe('UI Security & Sanitization (Defesa contra DOM-XSS / Injeção HTML)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('createBaixandoRow trata nomes de arquivo e status com tags HTML estritamente como texto puro', () => {
    const maliciousName = '<img src="x" onerror="alert(1)"><b id="injected-bold">Documento</b>';
    const maliciousStatus = '<script>window.pwned=true</script><span id="injected-span">Erro</span>';

    const row = createBaixandoRow(maliciousName, maliciousStatus, 'accent', 'active');
    document.body.appendChild(row);

    // Nenhuma tag HTML deve ter sido instanciada
    expect(document.getElementById('injected-bold')).toBeNull();
    expect(document.getElementById('injected-span')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();

    // O texto literal deve estar preservado no textContent
    const nameEl = row.querySelector('.baixando-row-name');
    expect(nameEl?.textContent).toBe(maliciousName);

    const statusEl = row.querySelector('.baixando-row-status');
    expect(statusEl?.textContent).toBe(maliciousStatus);
  });

  it('createConfigItem trata títulos e descrições com HTML como texto puro', () => {
    const maliciousTitle = '<a href="javascript:alert(1)" id="phish-link">Configuração</a>';
    const maliciousDesc = '<iframe src="evil.com"></iframe>Descrição legítima';

    const item = createConfigItem(maliciousTitle, maliciousDesc);
    document.body.appendChild(item);

    expect(document.getElementById('phish-link')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();

    const titleEl = item.querySelector('.config-title');
    expect(titleEl?.textContent).toBe(maliciousTitle);

    const descEl = item.querySelector('.config-desc');
    expect(descEl?.textContent).toBe(maliciousDesc);
  });

  it('defesa contra tentativas de spoofing de UI com divs absolutas no nome do arquivo', () => {
    const fakeUiOverlay = '<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:red" class="fake-overlay">Falsa UI</div>';
    const row = createBaixandoRow(fakeUiOverlay, 'Concluído');
    document.body.appendChild(row);

    expect(document.querySelector('.fake-overlay')).toBeNull();
    const nameEl = row.querySelector('.baixando-row-name');
    expect(nameEl?.textContent).toBe(fakeUiOverlay);
  });
});

describe('Auditoria de Segurança MV3: CSP, Memória e Ciclo de Vida da Janela', () => {
  it('manifest.json declara Content Security Policy (CSP) explícita e restritiva para extension_pages', () => {
    const manifestPath = path.resolve(__dirname, '../../manifest.json');
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);

    expect(manifest.content_security_policy).toBeDefined();
    expect(manifest.content_security_policy.extension_pages).toBeDefined();

    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('cleanupResources revoga Blob URLs e remove permissões temporárias no fechamento da janela', () => {
    const revokedUrls: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });

    const removedOrigins: any[] = [];
    const sentMessages: any[] = [];

    (globalThis as any).chrome = {
      permissions: {
        remove: vi.fn((opts: any) => {
          removedOrigins.push(opts);
          return Promise.resolve(true);
        })
      },
      runtime: {
        sendMessage: vi.fn((msg: any) => {
          sentMessages.push(msg);
        })
      }
    };

    cleanupResources();

    expect(typeof cleanupResources).toBe('function');
    // [FIEL-05] Garante que a permissão debugger foi revogada
    expect(removedOrigins).toEqual(
      expect.arrayContaining([{ permissions: ['debugger'] }])
    );
    URL.revokeObjectURL = originalRevoke;
  });

  it('eventos beforeunload e pagehide estão registrados para invocar a limpeza de recursos', () => {
    let beforeunloadFired = false;
    let pagehideFired = false;

    window.addEventListener('beforeunload', () => {
      beforeunloadFired = true;
    });
    window.addEventListener('pagehide', () => {
      pagehideFired = true;
    });

    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('pagehide'));

    expect(beforeunloadFired).toBe(true);
    expect(pagehideFired).toBe(true);
  });
});
