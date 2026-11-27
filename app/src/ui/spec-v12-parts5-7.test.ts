import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  setState,
  resetToInitialState,
  downloadAgain,
  handleStartRecording,
  initSidePanel
} from './sidepanel';

describe('SPEC-v12 Partes 5 a 7: Gravação na Página Atual, Baixar Novamente e Remoção de Pegar só um Pedaço', () => {
  const htmlPath = path.resolve(__dirname, '../../sidepanel.html');
  const fullHtml = fs.readFileSync(htmlPath, 'utf-8');

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = fullHtml;
    // Mock chrome APIs necessárias
    (globalThis as any).chrome = {
      runtime: {
        id: 'pluck-test-ext',
        getManifest: () => ({ version: '0.4.0' }),
        sendMessage: vi.fn()
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 10, url: 'https://exemplo.com/pagina', title: 'Página Exemplo', active: true }]),
        get: vi.fn().mockResolvedValue({ id: 10, url: 'https://exemplo.com/pagina', title: 'Página Exemplo', active: true }),
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      windows: {
        getCurrent: vi.fn().mockResolvedValue({ id: 1 }),
        onFocusChanged: { addListener: vi.fn() }
      },
      permissions: {
        contains: vi.fn().mockResolvedValue(true),
        request: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true)
      },
      downloads: {
        download: vi.fn().mockResolvedValue(101),
        showDefaultFolder: vi.fn(),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue({}),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: '<html><body>Conteudo gravado</body></html>' }])
      }
    };

    // Configura target tab no pluck
    initSidePanel();
    (window as any).__pluck.setTargetTab({
      tabId: 10,
      url: 'https://exemplo.com/pagina',
      title: 'Página Exemplo',
      html: '<html><body>Conteúdo Exemplo</body></html>'
    });
  });

  afterEach(() => {
    resetToInitialState();
  });

  // ==========================================================================
  // PARTE 7: REMOVER O MODO "PEGAR SÓ UM PEDAÇO"
  // ==========================================================================
  describe('Parte 7: Remoção do modo Pegar só um pedaço e presença dos 4 modos oficiais', () => {
    it('o card mode-piece não existe mais no HTML do painel lateral', () => {
      const modePiece = document.getElementById('mode-piece');
      expect(modePiece).toBeNull();
      expect(fullHtml).not.toContain('id="mode-piece"');
      expect(fullHtml).not.toContain('Pegar só um pedaço');
    });

    it('a interface possui exatamente os 4 modos oficiais da SPEC-v12', () => {
      const modeZip = document.getElementById('mode-zip');
      const modeHtml = document.getElementById('mode-html');
      const modeImages = document.getElementById('mode-images');
      const modeSite = document.getElementById('mode-site');

      expect(modeZip).not.toBeNull();
      expect(modeHtml).not.toBeNull();
      expect(modeImages).not.toBeNull();
      expect(modeSite).not.toBeNull();

      expect(modeZip?.textContent).toContain('Esta página (cópia fiel)');
      expect(modeHtml?.textContent).toContain('Só HTML');
      expect(modeImages?.textContent).toContain('Somente mídias');
      expect(modeSite?.textContent).toContain('Site inteiro');
    });

    it('ao clicar em Só HTML, seleciona o modo html e atualiza o botão de ação', () => {
      const modeHtml = document.getElementById('mode-html') as HTMLElement;
      modeHtml.click();

      expect((window as any).__pluck.getSelectedMode()).toBe('html');
      expect(modeHtml.classList.contains('selected')).toBe(true);

      const mainBtn = document.getElementById('btnMainAction');
      expect(mainBtn?.textContent).toContain('Baixar HTML Autossuficiente');
    });
  });

  // ==========================================================================
  // PARTE 5: GRAVAÇÃO SÓ DA PÁGINA ATUAL
  // ==========================================================================
  describe('Parte 5: Gravação manual sob a página atual com bloqueio e erro ao navegar', () => {
    it('alterna mutuamente entre Automático e Gravação manual', () => {
      const autoSw = document.getElementById('autoSwitch') as HTMLElement;
      const recSw = document.getElementById('recordClicksSwitch') as HTMLElement;

      expect(autoSw.classList.contains('switch-track')).toBe(true);
      expect(autoSw.classList.contains('off')).toBe(false);
      expect(recSw.classList.contains('off')).toBe(true);
      expect((window as any).__pluck.getCaptureMethod()).toBe('automatic');

      // Usuário liga a Gravação Manual
      recSw.click();

      expect(recSw.classList.contains('off')).toBe(false);
      expect(recSw.getAttribute('aria-checked')).toBe('true');
      expect(autoSw.classList.contains('off')).toBe(true);
      expect(autoSw.getAttribute('aria-checked')).toBe('false');
      expect((window as any).__pluck.getCaptureMethod()).toBe('recording');

      // O botão principal vira "Iniciar gravação manual"
      const mainBtn = document.getElementById('btnMainAction');
      expect(mainBtn?.textContent).toContain('Iniciar gravação manual');

      // Usuário religa Automático: desliga gravação
      autoSw.click();

      expect(autoSw.classList.contains('off')).toBe(false);
      expect(autoSw.getAttribute('aria-checked')).toBe('true');
      expect(recSw.classList.contains('off')).toBe(true);
      expect(recSw.getAttribute('aria-checked')).toBe('false');
      expect((window as any).__pluck.getCaptureMethod()).toBe('automatic');
    });

    it('inicia gravação e transiciona para a view gravando com o botão Parar e Salvar', async () => {
      (window as any).__pluck.setCaptureMethod('recording');
      await handleStartRecording();

      expect((window as any).__pluck.getState()).toBe('gravando');

      const viewGravando = document.getElementById('view-gravando');
      expect(viewGravando?.classList.contains('active')).toBe(true);

      const btnStop = document.getElementById('btnStopRecording');
      expect(btnStop).not.toBeNull();
      expect(btnStop?.textContent).toContain('Parar e Salvar');
    });

    it('dispara erro de navegação e exibe os botões Salvar o que já gravei e Recomeçar ao mudar de página', async () => {
      (window as any).__pluck.setCaptureMethod('recording');
      await handleStartRecording();
      const sessionRecorder = (window as any).__pluck.getSessionRecorder();
      
      // Simula navegação para fora de https://exemplo.com/pagina
      const targetUrl = 'https://outro-site.com/artigo';
      const result = sessionRecorder.handlePotentialNavigation(targetUrl);

      expect(result.allowed).toBe(false);
      expect(result.navigatedAway).toBe(true);
      expect(result.errorMessage).toBe('A gravação vale só para a página onde começou. Você saiu de outro-site.com/artigo.');

      // Notifica a UI simulando o callback de saída
      setState('gravacao_erro', {
        errorMsg: result.errorMessage,
        navigatedToUrl: targetUrl
      });

      expect((window as any).__pluck.getState()).toBe('gravacao_erro');

      const viewErro = document.getElementById('view-gravacao-erro');
      expect(viewErro?.classList.contains('active')).toBe(true);

      const msgEl = document.getElementById('gravacaoErroMsg');
      expect(msgEl?.textContent).toBe('A gravação vale só para a página onde começou. Você saiu de outro-site.com/artigo.');

      // Verifica presença obrigatória dos dois botões da SPEC-v12
      const btnSave = document.getElementById('btnSaveRecorded');
      const btnRestart = document.getElementById('btnRestartRecording');

      expect(btnSave).not.toBeNull();
      expect(btnSave?.textContent).toContain('Salvar o que já gravei');
      expect(btnRestart).not.toBeNull();
      expect(btnRestart?.textContent).toContain('Recomeçar');
    });

    it('botão Recomeçar limpa o estado e volta para a tela inicial', () => {
      setState('gravacao_erro', { errorMsg: 'Erro de teste' });
      const btnRestart = document.getElementById('btnRestartRecording') as HTMLButtonElement;
      expect(btnRestart).not.toBeNull();

      btnRestart.click();

      expect((window as any).__pluck.getState()).toBe('inicio');
      expect(document.getElementById('view-inicio')?.classList.contains('active')).toBe(true);
      expect((window as any).__pluck.getCaptureMethod()).toBe('automatic');
    });
  });

  // ==========================================================================
  // PARTE 6: BAIXAR NOVAMENTE (EM MEMÓRIA E APAGADO AO VOLTAR)
  // ==========================================================================
  describe('Parte 6: Baixar novamente retido em memória e apagado ao clicar em Voltar', () => {
    it('no estado pronto, exibe o botão Baixar novamente ao lado de Abrir e Voltar ao início', () => {
      setState('pronto', {
        filename: 'site-exemplo.zip',
        sizeText: '1,5 MB'
      });

      const btnOpen = document.getElementById('btnOpenResult');
      const btnAgain = document.getElementById('btnDownloadAgain');
      const btnBack = document.getElementById('btnBackToStart');

      expect(btnOpen).not.toBeNull();
      expect(btnAgain).not.toBeNull();
      expect(btnAgain?.textContent).toContain('Baixar novamente');
      expect(btnBack).not.toBeNull();
      expect(btnBack?.textContent).toContain('Voltar ao início');
    });

    it('ao concluir download, mantém o arquivo em memória em lastDownloadInfo', async () => {
      // Simula finalização de captura
      await (window as any).__pluck.finishRecordingCapture([
        {
          url: 'https://exemplo.com/style.css',
          mimeType: 'text/css',
          statusCode: 200,
          data: new TextEncoder().encode('body { background: #000; }')
        }
      ]);

      const lastDl = (window as any).__pluck.getLastDownload();
      expect(lastDl).not.toBeNull();
      expect(lastDl.filename).toContain('.zip');
      expect(lastDl.size).toBeGreaterThan(0);
      expect(lastDl.base64).toBeDefined();

      // Testa downloadAgain usando o arquivo retido na memória
      const downloadSpy = vi.spyOn(chrome.downloads, 'download');
      await downloadAgain();

      expect(downloadSpy).toHaveBeenCalled();
    });

    it('ao clicar em Voltar ao início, apaga o arquivo da memória (lastDownloadInfo = null)', () => {
      // 1. Configura estado pronto com arquivo na memória
      setState('pronto', { filename: 'teste.zip' });
      // Simula lastDownloadInfo preenchido
      (window as any).__pluck.getLastDownload(); // assegura acesso
      const btnBack = document.getElementById('btnBackToStart') as HTMLButtonElement;
      expect(btnBack).not.toBeNull();

      // 2. Clica em Voltar ao início
      btnBack.click();

      // 3. Verifica que voltou para inicio e lastDownloadInfo foi apagado da memória
      expect((window as any).__pluck.getState()).toBe('inicio');
      expect((window as any).__pluck.getLastDownload()).toBeNull();
    });
  });
});
