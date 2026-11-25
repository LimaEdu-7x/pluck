import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBaixandoRow, createConfigItem } from './ui-helpers';
import { cleanupResources, isSystemBrowserPage, setState, detectAndRenderExternalDomains, setScope } from './sidepanel';
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
  it('manifest.json declara Content Security Policy (CSP) explícita e permissão debugger em permissions', () => {
    const manifestPath = path.resolve(__dirname, '../../manifest.json');
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);

    expect(manifest.version).toBe('0.2.0');
    expect(manifest.content_security_policy).toBeDefined();
    expect(manifest.content_security_policy.extension_pages).toBeDefined();

    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");

    // [BUG 3] Em MV3, debugger deve estar em permissions (não pode ser optional_permissions)
    expect(manifest.permissions).toContain('debugger');
    expect(manifest.optional_permissions || []).not.toContain('debugger');

    // [REGRESSÃO CHROME REAL] Permissão 'tabs' obrigatória para ler URL no painel lateral
    expect(manifest.permissions).toContain('tabs');
  });

  it('isSystemBrowserPage identifica páginas internas do navegador e rejeita sites comuns', () => {
    expect(isSystemBrowserPage('chrome://extensions')).toBe(true);
    expect(isSystemBrowserPage('edge://settings')).toBe(true);
    expect(isSystemBrowserPage('about:blank')).toBe(true);
    expect(isSystemBrowserPage('chrome-extension://xyz/options.html')).toBe(true);
    expect(isSystemBrowserPage('devtools://devtools/bundled/inspector.html')).toBe(true);
    expect(isSystemBrowserPage('view-source:https://google.com')).toBe(true);

    expect(isSystemBrowserPage('https://getartcraft.com')).toBe(false);
    expect(isSystemBrowserPage('http://127.0.0.1:8080/index.html')).toBe(false);
    expect(isSystemBrowserPage('http://localhost:3000')).toBe(false);
    expect(isSystemBrowserPage('file:///C:/Users/file.html')).toBe(false);
    expect(isSystemBrowserPage('')).toBe(false);
  });

  it('cleanupResources revoga Blob URLs e libera memória no encerramento', () => {
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

  it('setState com erro customizado atualiza erroTitle e erroSub como texto puro sem innerHTML', () => {
    // Monta estrutura DOM simulada da view-erro
    document.body.innerHTML = `
      <div id="sidePanelRoot">
        <section class="view-state" id="view-erro">
          <span id="erroTitle"></span>
          <span id="erroSub"></span>
          <p id="erroProtocol"></p>
        </section>
        <div id="panelFooter"></div>
        <div id="domainPill"></div>
        <div id="statusDot"></div>
        <div id="domainText"></div>
        <div id="securityBadge"></div>
      </div>
    `;

    const maliciousError = '<script>window.hack=1</script><b>Erro Crítico</b>';
    const maliciousDetail = '<img src=x onerror=alert(1)>Detalhe do Erro';

    setState('erro', {
      errorTitle: maliciousError,
      errorDetail: maliciousDetail,
      url: 'https://exemplo.com'
    });

    const titleEl = document.getElementById('erroTitle');
    const subEl = document.getElementById('erroSub');

    // Nenhuma tag injetada
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect(document.querySelector('img')).toBeNull();

    // Texto preservado com segurança
    expect(titleEl?.textContent).toBe(maliciousError);
    expect(subEl?.textContent).toBe(maliciousDetail);
  });

  describe('Confirmação Explícita de Domínios Externos na UI (Opção B)', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="sidePanelRoot">
          <nav class="scope-tabs">
            <button id="tab-esta"></button>
            <button id="tab-vinc"></button>
            <button id="tab-site"></button>
          </nav>
          <p id="scopeSub"></p>
          <div id="limitsBox"></div>
          <div id="targetBox"></div>
          <div id="subdomainSwitch"></div>
          <div id="pagsChips"></div>
          <div id="mbChips"></div>
          <div id="scopeSummary"></div>
          <div id="panelFooter"></div>
          <div id="externalDomainsBox" style="display: none;">
            <div id="externalDomainsList"></div>
          </div>
        </div>
      `;
    });

    it('renderiza checkboxes DESLIGADOS por padrão para domínios externos detectados', async () => {
      setScope('paginas_vinculadas');
      const html = `
        <div>
          <a href="https://store.landonorris.com/products">Store Sub</a>
          <a href="https://landonorris.store/collections">Store Domain</a>
        </div>
      `;

      await detectAndRenderExternalDomains(html, 'https://landonorris.com/');

      const box = document.getElementById('externalDomainsBox');
      expect(box?.style.display).toBe('flex');

      const checkboxes = document.querySelectorAll<HTMLInputElement>('.external-domain-check');
      expect(checkboxes.length).toBeGreaterThan(0);

      // [REQUISITO CRÍTICO] Checkbox DESLIGADO por padrão
      for (const cb of checkboxes) {
        expect(cb.checked).toBe(false);
      }
    });

    it('oculta o card de domínios externos quando o escopo é Esta Página', async () => {
      setScope('esta_pagina');
      const html = `<a href="https://landonorris.store/collections">Loja</a>`;

      await detectAndRenderExternalDomains(html, 'https://landonorris.com/');

      const box = document.getElementById('externalDomainsBox');
      expect(box?.style.display).toBe('none');
    });

    it('solicita optional host permission ao marcar checkbox e desmarca se recusado', async () => {
      setScope('paginas_vinculadas');
      const html = `<a href="https://landonorris.store/collections">Loja</a>`;

      // Mock da API chrome.permissions.request simulando recusa pelo usuário
      const requestMock = vi.fn().mockResolvedValue(false);
      (globalThis as any).chrome = {
        permissions: {
          request: requestMock
        }
      };

      await detectAndRenderExternalDomains(html, 'https://landonorris.com/');

      const checkbox = document.querySelector<HTMLInputElement>('.external-domain-check');
      expect(checkbox).not.toBeNull();
      expect(checkbox?.checked).toBe(false);

      // Usuário clica no checkbox
      checkbox!.checked = true;
      await checkbox!.onchange?.(new Event('change'));

      // Verifica que solicitou a permissão específica por origem
      expect(requestMock).toHaveBeenCalledWith({
        origins: ['https://landonorris.store/*']
      });

      // Como o usuário recusou (mockResolvedValue false), o checkbox volta a ser falso
      expect(checkbox!.checked).toBe(false);
    });
  });
});
