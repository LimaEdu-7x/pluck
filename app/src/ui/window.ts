import { availableModules } from '../modules';
import { validateUrl, isLocalhostPage } from '../core/security/url-guard';
import { capturePageHtml, capturePageZip } from '../core/capture/capture-engine';
import { collectImagesFromDom, captureImagesZip } from '../core/capture/image-collector';
import { createConfigItem, createModeCard } from './ui-helpers';

export type UiState = 'inicio' | 'analisando' | 'baixando' | 'pronto' | 'erro' | 'permissao' | 'login';

let currentState: UiState = 'inicio';
let selectedModuleId = 'page-html'; // [DECISÃO DO EDU] Somente HTML da página é o PADRÃO ao abrir
let currentTabId: number | null = null;
let currentTabUrl: string = 'http://localhost';
let currentTabTitle: string = 'Página';
let currentTabOrigin: string = '';
let targetTabOverrideHtml: string | null = null;
let loginConsentAccepted = false;
let activeRequestedOrigin: string | null = null;
let activeBlobUrl: string | null = null;
let currentWindowId: number | null = null;

if (typeof chrome !== 'undefined' && chrome.windows && typeof chrome.windows.getCurrent === 'function') {
  chrome.windows.getCurrent((win) => {
    if (win?.id) currentWindowId = win.id;
  });
}

export function cleanupResources() {
  if (activeBlobUrl) {
    try {
      URL.revokeObjectURL(activeBlobUrl);
    } catch {}
    activeBlobUrl = null;
  }
  if (activeRequestedOrigin) {
    const origin = activeRequestedOrigin;
    activeRequestedOrigin = null;
    if (typeof chrome !== 'undefined') {
      if (chrome.permissions && typeof chrome.permissions.remove === 'function') {
        try {
          chrome.permissions.remove({ origins: [origin] });
        } catch {}
      }
      if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
          chrome.runtime.sendMessage({
            type: 'PERMISSION_RELEASED',
            origin,
            windowId: currentWindowId,
            tabId: currentTabId
          });
        } catch {}
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', cleanupResources);
  window.addEventListener('pagehide', cleanupResources);
}

function updateSecurityPill(url: string) {
  const secDot = document.getElementById('securityDot');
  const secText = document.getElementById('securityText');
  if (!secDot || !secText) return;

  if (url.startsWith('https://')) {
    secDot.className = 'status-dot';
    secText.textContent = 'HTTPS (Seguro)';
  } else if (url.startsWith('http://localhost') || url.startsWith('http://127.') || url.startsWith('http://[::1]')) {
    secDot.className = 'status-dot';
    secText.textContent = 'Localhost';
  } else if (url.startsWith('http://')) {
    secDot.className = 'status-dot warn';
    secText.textContent = 'HTTP (Não seguro)';
  } else {
    secDot.className = 'status-dot muted';
    secText.textContent = 'Sistema';
  }
}

// Ajuste fino do tamanho da janela popup para garantir 720x400 de área útil no SO
function adjustWindowSize() {
  if (typeof window === 'undefined') return;
  const targetW = 720;
  const targetH = 400;
  const diffW = targetW - window.innerWidth;
  const diffH = targetH - window.innerHeight;
  if (diffW !== 0 || diffH !== 0) {
    try {
      window.resizeBy(diffW, diffH);
    } catch {}
  }
}

// Configurações contextuais da coluna direita para o Estado Início (Horizontal)
function renderConfigItems() {
  const container = document.getElementById('configItems');
  if (!container) return;

  if (selectedModuleId === 'page-html') {
    container.replaceChildren(
      createConfigItem('Estrutura HTML higienizada', 'Salva o documento HTML limpo e estruturado'),
      createConfigItem('Scripts removidos', 'Tags <script> e ouvintes de evento expurgados'),
      createConfigItem('Sem CSS, imagens ou fontes', 'Baixa apenas o código semântico da página'),
      createConfigItem('Privacidade total', 'Processamento 100% local direto no seu navegador')
    );
  } else if (selectedModuleId === 'images-zip') {
    container.replaceChildren(
      createConfigItem('Formatos Nativos:', 'PNG, JPG, WebP e SVG extraídos do DOM'),
      createConfigItem('Deduplicação Inteligente:', 'Mesma imagem referenciada várias vezes salva 1 única vez'),
      createConfigItem('Vetor Seguro:', 'SVGs higienizados sem scripts nem referências externas'),
      createConfigItem('Privacidade Total:', 'Nenhum dado trafega por servidores externos')
    );
  } else {
    // page-zip
    container.replaceChildren(
      createConfigItem('Estrutura HTML:', 'Salva o DOM estático higienizado sem scripts'),
      createConfigItem('Estilos Visuais:', 'Folhas CSS externas e inline unificadas no pacote'),
      createConfigItem('Fontes e Ativos:', 'Fontes WOFF2 locais preservadas para fidelidade'),
      createConfigItem('Privacidade Total:', 'Nenhum dado trafega por servidores externos')
    );
  }
}

export function setState(state: UiState, data?: any) {
  currentState = state;
  const states: UiState[] = ['inicio', 'analisando', 'baixando', 'pronto', 'erro', 'permissao', 'login'];
  for (const s of states) {
    const elId = 'state' + s.charAt(0).toUpperCase() + s.slice(1);
    const el = document.getElementById(elId);
    if (el) {
      if (s === state) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  }

  const mainBtn = document.getElementById('mainActionBtn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('cancelActionBtn') as HTMLButtonElement | null;
  const footerSubtext = document.getElementById('footerSubtext');
  const domainDot = document.getElementById('domainDot');
  const domainText = document.getElementById('domainText');

  // Ajustes de botões e cabeçalho por estado
  if (state === 'inicio') {
    renderConfigItems();
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (footerSubtext) footerSubtext.textContent = 'Processamento 100% local no seu navegador';
    if (domainDot) {
      domainDot.className = 'status-dot';
    }
    updateButtonText();
  } else if (state === 'analisando') {
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (mainBtn) {
      mainBtn.disabled = true;
      mainBtn.textContent = 'Analisando recursos...';
    }
    if (footerSubtext) footerSubtext.textContent = 'Compactação assíncrona com stream local';
    if (data?.subtitle) {
      const el = document.getElementById('analisandoSubtitle');
      if (el) el.textContent = data.subtitle;
    }
  } else if (state === 'baixando') {
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-flex';
      cancelBtn.textContent = 'Cancelar download';
    }
    if (mainBtn) {
      mainBtn.disabled = true;
      mainBtn.textContent = 'Baixando...';
    }
    if (footerSubtext) footerSubtext.textContent = 'Processamento local em andamento';

    const bTitle = document.getElementById('baixandoTitle');
    const bSub = document.getElementById('baixandoSubtitle');
    const bFile = document.getElementById('baixandoFilename');
    const bPercent = document.getElementById('baixandoPercent');
    const bFill = document.getElementById('baixandoProgressFill');
    const bNote = document.getElementById('baixandoNote');

    if (selectedModuleId === 'page-html') {
      if (bTitle) bTitle.textContent = 'Salvando documento HTML...';
      if (bSub) bSub.textContent = 'Higienizando DOM e preparando download direto';
      if (bFile) bFile.textContent = data?.filename || `${currentTabTitle || 'pagina'}.html`;
      if (bPercent) bPercent.textContent = '100%';
      if (bFill) bFill.style.width = '100%';
      if (bNote) bNote.textContent = 'Salvando na pasta Downloads do sistema · 1 arquivo único';
    } else {
      if (bTitle) bTitle.textContent = 'Empacotando e baixando arquivos...';
      if (bSub) bSub.textContent = 'Salvando no pacote sem congelar o navegador';
      if (bFile) bFile.textContent = data?.filename || `${currentTabTitle || 'pagina'}.zip`;
      if (bPercent) bPercent.textContent = data?.percent || '0%';
      if (bFill) bFill.style.width = data?.percent || '0%';
      if (bNote) bNote.textContent = 'Salvando na pasta Downloads do sistema';
    }
  } else if (state === 'pronto') {
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (mainBtn) {
      mainBtn.disabled = false;
      mainBtn.textContent = selectedModuleId === 'page-html' ? 'Abrir arquivo .html' : 'Abrir arquivo ZIP';
    }
    if (footerSubtext) footerSubtext.textContent = 'Arquivo salvo na pasta padrão do navegador';

    const pFile = document.getElementById('prontoFilename');
    const pDetails = document.getElementById('prontoDetails');
    const pSub = document.getElementById('prontoSubtitle');
    const noticeBox = document.getElementById('prontoNoticeBox');
    const warnBox = document.getElementById('prontoWarnBox');

    if (pFile) pFile.textContent = data?.filename || (selectedModuleId === 'page-html' ? 'pagina.html' : 'pagina.zip');

    if (selectedModuleId === 'page-html') {
      if (pSub) pSub.textContent = 'Arquivo HTML salvo e pronto na sua pasta local';
      if (pDetails) pDetails.textContent = `${data?.size || '0 KB'} · 1 arquivo salvo · Documento HTML`;
      if (noticeBox) noticeBox.style.display = 'block';
      if (warnBox) warnBox.style.display = 'none';
    } else {
      if (pSub) pSub.textContent = 'Pacote ZIP gerado com sucesso na pasta Downloads';
      if (pDetails) pDetails.textContent = `${data?.size || '0 KB'} · ${data?.itemCount || 0} arquivos salvos · Pacote ZIP`;
      if (noticeBox) noticeBox.style.display = 'none';
      if (data?.incomplete) {
        if (warnBox) warnBox.style.display = 'block';
      } else {
        if (warnBox) warnBox.style.display = 'none';
      }
    }

    const metaRow = document.getElementById('prontoMetaRow');
    if (metaRow && data?.elapsedTime) {
      metaRow.textContent = `Tempo total: ${data.elapsedTime} · Pasta Downloads do sistema`;
    }
  } else if (state === 'erro') {
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (mainBtn) {
      mainBtn.disabled = true;
      mainBtn.textContent = 'Aguardando Aba Compatível';
    }
    if (footerSubtext) footerSubtext.textContent = 'Mude para outra aba para ativar o Pluck automaticamente';
    if (domainDot) domainDot.className = 'status-dot muted';
    if (domainText) domainText.textContent = 'chrome://extens...';
  } else if (state === 'permissao') {
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-flex';
      cancelBtn.textContent = 'Recusar e Cancelar';
    }
    if (mainBtn) {
      mainBtn.disabled = false;
      mainBtn.textContent = 'Conceder Permissão e Baixar';
    }
    if (footerSubtext) footerSubtext.textContent = 'Você pode revogar este acesso nas opções da extensão';
  } else if (state === 'login') {
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (mainBtn) {
      mainBtn.disabled = false;
      mainBtn.textContent = 'Prosseguir com o Download (ZIP)';
    }
    if (footerSubtext) footerSubtext.textContent = 'Para cancelar, feche este popup a qualquer momento';
    if (domainDot) domainDot.className = 'status-dot warn';
  }
}

function renderModeCards() {
  const container = document.getElementById('modeCardList');
  if (!container) return;

  container.replaceChildren();
  for (const mod of availableModules) {
    const card = createModeCard(mod, mod.id === selectedModuleId, () => selectMode(mod.id));
    container.appendChild(card);
  }
}

export function selectMode(id: string) {
  selectedModuleId = id;
  renderModeCards();
  renderConfigItems();
  updateButtonText();
}

function updateButtonText() {
  const btn = document.getElementById('mainActionBtn') as HTMLButtonElement | null;
  if (!btn || currentState !== 'inicio') return;

  btn.disabled = false;
  if (selectedModuleId === 'page-html') {
    btn.textContent = 'Baixar somente o HTML';
  } else if (selectedModuleId === 'images-zip') {
    btn.textContent = 'Baixar Somente Imagens (ZIP)';
  } else {
    btn.textContent = 'Baixar Página Completa (ZIP)';
  }
}

async function updateActiveTab() {
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    try {
      let targetTab: chrome.tabs.Tab | undefined;
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (activeTab && activeTab.url && !activeTab.url.startsWith('chrome-extension://')) {
        targetTab = activeTab;
      } else {
        const allTabs = await chrome.tabs.query({});
        targetTab = allTabs.find((t) => t.url && (t.url.startsWith('http:') || t.url.startsWith('https:'))) || activeTab;
      }

      if (targetTab && targetTab.url && !targetTab.url.startsWith('chrome-extension://')) {
        currentTabId = targetTab.id ?? null;
        currentTabUrl = targetTab.url;
        currentTabTitle = targetTab.title || 'Página';

        try {
          const u = new URL(currentTabUrl);
          currentTabOrigin = u.origin;
          const domainText = document.getElementById('domainText');
          if (domainText) {
            domainText.textContent = u.hostname || 'localhost';
          }
        } catch {
          currentTabOrigin = '';
        }

        const titleEl = document.getElementById('tabTitle');
        if (titleEl) titleEl.textContent = currentTabTitle;

        const urlEl = document.getElementById('tabUrl');
        if (urlEl) urlEl.textContent = currentTabUrl;
        updateSecurityPill(currentTabUrl);

        // Validação imediata: se for chrome:// ou URL restrita, transiciona para estado de erro
        const allowLocalhost = isLocalhostPage(currentTabUrl);
        const urlCheck = validateUrl(currentTabUrl, allowLocalhost);
        if (!urlCheck.valid) {
          setState('erro', { reason: urlCheck.reason });
        }
      }
    } catch (e) {
      console.warn('Não foi possível obter aba ativa na janela horizontal:', e);
    }
  }
}

async function handleActionClick() {
  if (currentState === 'pronto') {
    setState('inicio');
    return;
  }

  if (currentState === 'login') {
    const chk = document.getElementById('loginConsentCheck') as HTMLInputElement | null;
    if (chk && chk.checked) {
      loginConsentAccepted = true;
    } else {
      return;
    }
  }

  if (currentTabUrl.startsWith('chrome-extension://') && typeof chrome !== 'undefined' && chrome.tabs) {
    const allTabs = await chrome.tabs.query({});
    const httpTab = allTabs.find((t) => t.url && (t.url.startsWith('http:') || t.url.startsWith('https:')));
    if (httpTab && httpTab.url) {
      currentTabId = httpTab.id ?? null;
      currentTabUrl = httpTab.url;
      currentTabTitle = httpTab.title || 'Página';
      try {
        currentTabOrigin = new URL(currentTabUrl).origin;
      } catch {}
    }
  }

  // [SEC-04 / NOVO-02] Valida a URL da aba ativa com url-guard
  const allowLocalhost = isLocalhostPage(currentTabUrl);
  const urlCheck = validateUrl(currentTabUrl, allowLocalhost);
  if (!urlCheck.valid) {
    setState('erro', { reason: urlCheck.reason });
    return;
  }

  // REGRA CRÍTICA: permissions.request síncrono na 1ª linha
  const isLocalhost = isLocalhostPage(currentTabOrigin || currentTabUrl);
  const originToRequest = !isLocalhost && currentTabOrigin && (currentTabOrigin.startsWith('http:') || currentTabOrigin.startsWith('https:'))
    ? currentTabOrigin + '/*'
    : null;

  const permissionPromise = (originToRequest && typeof chrome !== 'undefined' && chrome.permissions)
    ? chrome.permissions.request({ origins: [originToRequest] }).catch(() => false)
    : Promise.resolve(true);

  setState('analisando', { subtitle: 'Varredura de elementos locais em andamento' });

  try {
    const permGranted = await permissionPromise;
    if (!permGranted && originToRequest) {
      setState('permissao');
      return;
    }
    if (originToRequest) {
      activeRequestedOrigin = originToRequest;
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
          chrome.runtime.sendMessage({
            type: 'PERMISSION_ACQUIRED',
            origin: originToRequest,
            windowId: currentWindowId,
            tabId: currentTabId
          });
        } catch {}
      }
    }

    let pageRawHtml = targetTabOverrideHtml || '<!DOCTYPE html><html><head><title>Pluck Sandbox</title></head><body><h1>Pluck Sandbox</h1></body></html>';

    if (typeof chrome !== 'undefined' && chrome.scripting && currentTabId && !targetTabOverrideHtml) {
      try {
        const scriptResults = await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          func: () => ({
            html: document.documentElement.outerHTML,
            baseURI: document.baseURI || window.location.href,
            title: document.title || 'Página',
            hasPassword: !!document.querySelector('input[type="password"]')
          })
        });

        if (scriptResults && scriptResults[0] && scriptResults[0].result) {
          const r = scriptResults[0].result as { html: string; baseURI: string; title: string; hasPassword?: boolean };
          pageRawHtml = r.html;
          currentTabTitle = r.title || currentTabTitle;

          // Detecção de sessão com login
          if (r.hasPassword && !loginConsentAccepted && currentState !== 'login') {
            setState('login');
            return;
          }
        }
      } catch (scriptErr) {
        console.warn('Scripting error:', scriptErr);
      }
    }

    const currentModule = availableModules.find((m) => m.id === selectedModuleId);
    if (!currentModule) throw new Error('Módulo não encontrado');

    const startTime = performance.now();
    setState('baixando', {
      filename: selectedModuleId === 'page-html' ? `${currentTabTitle || 'pagina'}.html` : `${currentTabTitle || 'pagina'}.zip`,
      percent: '0%',
      loaded: 0,
      total: 1
    });

    const result = await currentModule.run({
      tabId: currentTabId || undefined,
      url: currentTabUrl,
      title: currentTabTitle,
      html: pageRawHtml,
      onProgress: (loaded: number, total: number, currentItem?: string) => {
        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        setState('baixando', {
          filename: selectedModuleId === 'page-html' ? `${currentTabTitle || 'pagina'}.html` : `${currentTabTitle || 'pagina'}.zip`,
          percent: `${pct}%`,
          loaded,
          total,
          currentItem
        });
      }
    });

    activeBlobUrl = URL.createObjectURL(result.blob);
    const blobUrl = activeBlobUrl;

    if (typeof chrome !== 'undefined' && chrome.downloads) {
      const downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename: result.filename,
        saveAs: false
      });

      // [SEC-MEM] Libera o Blob URL da memória quando o download terminar ou for interrompido
      if (chrome.downloads.onChanged) {
        const listener = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id === downloadId && delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
            chrome.downloads.onChanged.removeListener(listener);
            try {
              URL.revokeObjectURL(blobUrl);
            } catch {}
            if (activeBlobUrl === blobUrl) activeBlobUrl = null;
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
      setTimeout(() => {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {}
        if (activeBlobUrl === blobUrl) activeBlobUrl = null;
      }, 30000);
    } else {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = result.filename;
      a.click();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {}
        if (activeBlobUrl === blobUrl) activeBlobUrl = null;
      }, 1000);
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1).replace('.', ',');
    const formattedSize = result.blob.size < 1024 * 1024
      ? `${Math.max(1, Math.round(result.blob.size / 1024))} KB`
      : `${(result.blob.size / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;

    // Transição para estado Pronto com dados reais
    setState('pronto', {
      filename: result.filename,
      size: formattedSize,
      itemCount: result.itemCount,
      incomplete: result.incomplete,
      elapsedTime: `${elapsed} segundos`
    });
  } catch (err) {
    console.error('Erro na extração:', err);
    if (activeBlobUrl) {
      try {
        URL.revokeObjectURL(activeBlobUrl);
      } catch {}
      activeBlobUrl = null;
    }
    setState('erro', { reason: String(err) });
  } finally {
    cleanupResources();
  }
}

// Exposição do objeto de automação e inspeção para testes em sandbox
if (typeof window !== 'undefined') {
  (window as any).__pluck = {
    setState,
    getState: () => currentState,
    getSelectedModule: () => selectedModuleId,
    selectMode,
    handleActionClick,
    capturePageHtml,
    capturePageZip,
    collectImagesFromDom,
    captureImagesZip,
    availableModules,
    setTargetTab: (tab: { id?: number; url: string; title: string; html?: string }) => {
      if (tab.id !== undefined) currentTabId = tab.id;
      if (tab.url) {
        currentTabUrl = tab.url;
        updateSecurityPill(tab.url);
        try {
          currentTabOrigin = new URL(tab.url).origin;
          const domainText = document.getElementById('domainText');
          const domainDot = document.getElementById('domainDot');
          if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
            if (domainText) domainText.textContent = 'chrome://extens...';
            if (domainDot) domainDot.className = 'status-dot muted';
          } else {
            if (domainText) domainText.textContent = new URL(tab.url).hostname || 'artigo.com';
            if (domainDot) domainDot.className = 'status-dot';
          }
          const tabUrlEl = document.getElementById('tabUrl');
          if (tabUrlEl) tabUrlEl.textContent = tab.url;
        } catch {
          currentTabOrigin = '';
        }
      }
      if (tab.title) {
        currentTabTitle = tab.title;
        const titleEl = document.getElementById('tabTitle');
        if (titleEl) titleEl.textContent = tab.title;
      }
      if (tab.html) targetTabOverrideHtml = tab.html;

      const allowLocalhost = isLocalhostPage(currentTabUrl);
      const urlCheck = validateUrl(currentTabUrl, allowLocalhost);
      if (!urlCheck.valid) {
        setState('erro', { reason: urlCheck.reason });
      } else {
        setState('inicio');
      }
    }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  adjustWindowSize();
  renderModeCards();
  renderConfigItems();
  updateButtonText();
  updateActiveTab();

  const mainBtn = document.getElementById('mainActionBtn');
  if (mainBtn) {
    mainBtn.addEventListener('click', handleActionClick);
  }

  const cancelBtn = document.getElementById('cancelActionBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      cleanupResources();
      setState('inicio');
    });
  }
});
