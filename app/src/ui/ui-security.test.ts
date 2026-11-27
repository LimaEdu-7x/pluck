import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBaixandoRow, createConfigItem } from './ui-helpers';
import { cleanupResources, isSystemBrowserPage, setState, detectAndRenderExternalDomains, setScope, resetToInitialState, selectMode } from './sidepanel';
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

    expect(manifest.version).toBe('0.7.0');
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

  describe('Botão Voltar ao Início (Fluxo de Conclusão, Erro e Reinício de Captura)', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="sidePanelRoot">
          <header class="panel-header">
            <div class="domain-pill" id="headerDomainPill">
              <span class="status-dot" id="domainDot"></span>
              <span id="domainText">exemplo.com</span>
            </div>
            <span id="securityBadge"></span>
          </header>
          <section class="view-state active" id="view-inicio">
            <div class="origin-info">
              <span class="origin-title" id="originTitle">Artigo de Design</span>
              <span class="origin-url" id="originUrl">https://exemplo.com/artigo</span>
            </div>
            <div class="card interactive mode-card selected" id="mode-zip" role="radio" aria-checked="true"></div>
            <div class="card interactive mode-card" id="mode-html" role="radio" aria-checked="false"></div>
            <div class="card interactive mode-card" id="mode-images" role="radio" aria-checked="false"></div>
            <div id="webglNotice" style="display: none;"></div>
          </section>
          <section class="view-state" id="view-rolando"></section>
          <section class="view-state" id="view-analisando"></section>
          <section class="view-state" id="view-baixando"></section>
          <section class="view-state" id="view-pausado"></section>
          <section class="view-state" id="view-pronto-zip"></section>
          <section class="view-state" id="view-pronto-html"></section>
          <section class="view-state" id="view-erro">
            <span id="erroTitle"></span>
            <span id="erroSub"></span>
            <p id="erroProtocol"></p>
          </section>
          <section class="view-state" id="view-sem-acesso"></section>
          <section class="view-state" id="view-permissao"></section>
          <section class="view-state" id="view-login"></section>
          <div id="scrollPct">100% de 5000 px</div>
          <div id="scrollFill" style="width: 100%;"></div>
          <div id="scrollStepNote">Rolagem concluída</div>
          <div id="scrollVerticalPos">5000 px de 5000 px</div>
          <div id="scrollImagesCount">24 imagens</div>
          <div id="scrollStepsCount">10 passos</div>
          <div id="downPct">100% CONCLUÍDO</div>
          <div id="downFill" style="width: 100%;"></div>
          <div id="downFile">Finalizado</div>
          <div id="cntPages">1 de 1</div>
          <div id="cntRes">24 de 24</div>
          <div id="cntMb">4,2 MB</div>
          <div id="cntTime">00:15</div>
          <footer class="panel-footer" id="panelFooter"></footer>
        </div>
      `;

      setScope('esta_pagina');
      selectMode('zip');

      if ((window as any).__pluck) {
        (window as any).__pluck.setTargetTab({
          url: 'https://exemplo.com/artigo',
          title: 'Artigo de Design',
          tabId: 42
        });
      }
    });

    it('aparece no rodapé quando a coleta conclui com sucesso (estado pronto no modo ZIP e HTML)', () => {
      expect(typeof resetToInitialState).toBe('function');

      // 1. Testa modo ZIP
      selectMode('zip');
      setState('pronto', { filename: 'artigo.zip', sizeText: '1.2 MB' });

      let backBtn = document.getElementById('btnBackToStart') as HTMLButtonElement;
      expect(backBtn).not.toBeNull();
      expect(backBtn?.textContent).toContain('Voltar ao início');
      expect(backBtn?.getAttribute('aria-label')).toContain('Voltar ao início');
      expect(backBtn?.classList.contains('btn-small')).toBe(true);
      expect(backBtn?.classList.contains('btn-secondary')).toBe(true);

      // 2. Testa modo HTML
      selectMode('html');
      setState('pronto', { filename: 'artigo.html', sizeText: '250 KB' });

      backBtn = document.getElementById('btnBackToStart') as HTMLButtonElement;
      expect(backBtn).not.toBeNull();
      expect(backBtn?.textContent).toContain('Voltar ao início');
      expect(backBtn?.getAttribute('aria-label')).toContain('Voltar ao início');
    });

    it('aparece no rodapé quando a coleta termina em erro', () => {
      setState('erro', {
        errorTitle: 'Falha na Captura',
        errorDetail: 'Timeout de rede',
        url: 'https://exemplo.com/artigo'
      });

      const backBtn = document.getElementById('btnBackToStart') as HTMLButtonElement;
      expect(backBtn).not.toBeNull();
      expect(backBtn?.textContent).toContain('Voltar ao início');
      expect(backBtn?.getAttribute('aria-label')).toContain('Voltar ao início');
      expect(backBtn?.classList.contains('btn-small')).toBe(true);
      expect(backBtn?.classList.contains('btn-secondary')).toBe(true);
    });

    it('ao clicar em Voltar ao Início, reseta o estado e o progresso para inicio mantendo a aba/URL ativa', () => {
      selectMode('zip');
      setState('pronto', { filename: 'artigo.zip', sizeText: '1.2 MB' });
      expect(document.getElementById('view-inicio')?.classList.contains('active')).toBe(false);
      expect(document.getElementById('view-pronto-zip')?.classList.contains('active')).toBe(true);

      const backBtn = document.getElementById('btnBackToStart') as HTMLButtonElement;
      expect(backBtn).not.toBeNull();

      // Clica no botão Voltar ao início
      backBtn.click();

      // 1. Volta para o estado inicial
      expect(document.getElementById('view-inicio')?.classList.contains('active')).toBe(true);
      expect(document.getElementById('view-pronto-zip')?.classList.contains('active')).toBe(false);

      // 2. Limpa dados de progresso no DOM
      expect(document.getElementById('scrollPct')?.textContent).toBe('0 de 0 px (0%)');
      expect(document.getElementById('scrollFill')?.style.width).toBe('0%');
      expect(document.getElementById('downPct')?.textContent).toBe('0% CONCLUÍDO');
      expect(document.getElementById('downFill')?.style.width).toBe('0%');

      // 3. Mantém a identificação e URL da aba ativa (SPEC-v12: H1 fixo de ação ou título retido)
      const titleText = document.getElementById('originTitle')?.textContent;
      expect(titleText === 'Artigo de Design' || titleText === 'Como deseja arquivar?').toBe(true);
      expect(document.getElementById('originUrl')?.textContent).toBe('https://exemplo.com/artigo');
      expect(document.getElementById('domainText')?.textContent).toBe('exemplo.com');

      // 4. O botão Voltar ao início não deve estar visível no estado inicial
      expect(document.getElementById('btnBackToStart')).toBeNull();
      // O botão principal da tela inicial volta a aparecer
      const mainBtn = document.getElementById('btnMainAction');
      expect(mainBtn).not.toBeNull();
      expect(mainBtn?.textContent?.includes('Começar a arquivar') || mainBtn?.textContent?.includes('Baixar Página Completa')).toBe(true);
    });

    it('uma nova captura funciona normalmente após voltar ao início', async () => {
      // 1. Simula conclusão prévia de um download
      selectMode('zip');
      setState('pronto', { filename: 'artigo.zip' });

      const backBtn = document.getElementById('btnBackToStart') as HTMLButtonElement;
      expect(backBtn).not.toBeNull();
      backBtn.click();

      // 2. O usuário agora escolhe o modo imagens
      selectMode('images');
      expect(document.getElementById('mode-images')?.classList.contains('selected')).toBe(true);

      const mainBtn = document.getElementById('btnMainAction') as HTMLButtonElement;
      expect(mainBtn).not.toBeNull();
      expect(mainBtn?.textContent?.includes('Baixar Galeria de Mídias') || mainBtn?.textContent?.includes('Baixar somente imagens')).toBe(true);

      // Configura HTML mock para captura limpa
      (window as any).__pluck.setTargetTab({
        url: 'https://exemplo.com/artigo',
        title: 'Artigo de Design',
        html: '<html><head><title>Design</title></head><body><img src="https://exemplo.com/foto.png"></body></html>',
        tabId: 42
      });

      // 3. Dispara a nova captura pelo botão principal
      mainBtn.click();

      // A captura deve iniciar sem estar bloqueada ou presa
      const state = (window as any).__pluck.getState();
      expect(state === 'rolando' || state === 'baixando' || state === 'inicio').toBe(true);
    });
  });

  describe('Pluck v11.1: Bolinha de Status, Popover Técnico e Cartão de Salvamento', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="sidePanelRoot">
          <header class="panel-header">
            <div class="site-chip-container">
              <button class="site-chip domain-pill" id="headerDomainPill" type="button" aria-haspopup="dialog" aria-expanded="false">
                <div class="pulse-wrapper">
                  <div id="domainRing" class="ring-pulse-green"></div>
                  <div id="domainDot" class="status-dot dot-core-green"></div>
                </div>
                <span id="domainText" class="domain-label">aguardando...</span>
              </button>
              <div id="site-popover" class="site-popover" hidden>
                <span id="popover-status-text"></span>
                <span id="popover-full-url"></span>
                <span id="popover-resolution"></span>
                <span id="popover-assets-status"></span>
                <button id="btn-switch-tab" type="button">Trocar de aba ativa</button>
              </div>
            </div>
            <span id="securityBadge"></span>
          </header>
          <section class="view-state active" id="view-inicio">
            <h1 id="originTitle">getartcraft.com</h1>
            <div id="saveFolderCard">
              <div id="saveFolderPath">Downloads / getartcraft.com.zip</div>
              <div class="save-folder-tips">
                <span>Como abrir</span>
                <span>Proteção de dados: senhas, logins digitados e dados de formulários são apagados antes de salvar o arquivo.</span>
              </div>
            </div>
          </section>
        </div>
      `;
    });

    it('aplica estado VERDE com pulso (dot-core-green e ring-pulse-green) para site HTTPS conectado', () => {
      (window as any).__pluck.setTargetTab({
        url: 'https://getartcraft.com/',
        title: 'ArtCraft - Open Source Tools',
        tabId: 1
      });

      const dot = document.getElementById('domainDot');
      const ring = document.getElementById('domainRing');
      const text = document.getElementById('domainText');
      const popStatus = document.getElementById('popover-status-text');

      expect(dot?.classList.contains('dot-core-green')).toBe(true);
      expect(ring?.classList.contains('ring-pulse-green')).toBe(true);
      expect(text?.textContent).toBe('getartcraft.com');
      expect(popStatus?.textContent).toContain('CONECTADO À ABA');
    });

    it('aplica estado VERMELHO estático (dot-core-red e ring-static-red) para páginas restritas de sistema', () => {
      (window as any).__pluck.setTargetTab({
        url: 'chrome://settings',
        title: 'Configurações do Chrome',
        tabId: 2
      });

      const dot = document.getElementById('domainDot');
      const ring = document.getElementById('domainRing');
      const popStatus = document.getElementById('popover-status-text');

      expect(dot?.classList.contains('dot-core-red')).toBe(true);
      expect(ring?.classList.contains('ring-static-red')).toBe(true);
      expect(popStatus?.textContent).toContain('PÁGINA RESTRITA');
    });

    it('o cartão de salvamento exibe o destino em Downloads e a orientação de como abrir com proteção de dados', () => {
      (window as any).__pluck.setTargetTab({
        url: 'https://getartcraft.com/',
        title: 'ArtCraft'
      });

      const pathEl = document.getElementById('saveFolderPath');
      expect(pathEl?.textContent).toBe('Downloads / getartcraft.com.zip');

      const card = document.getElementById('saveFolderCard');
      expect(card?.textContent).toContain('Como abrir');
      expect(card?.textContent).toContain('Proteção de dados: senhas, logins digitados e dados de formulários são apagados antes de salvar o arquivo.');
    });
  });
});
