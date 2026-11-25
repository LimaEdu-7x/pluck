import { availableModules } from '../modules';
import { validateUrl, isLocalhostPage } from '../core/security/url-guard';
import { capturePageHtml, capturePageZip } from '../core/capture/capture-engine';
import { collectImagesFromDom, captureImagesZip } from '../core/capture/image-collector';
import { createBaixandoRow, createModeCard } from './ui-helpers';

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
  const subtextEl = document.getElementById('actionSubtext');
  const domainDot = document.getElementById('domainDot');
  const domainText = document.getElementById('domainText');

  if (state === 'inicio') {
    if (subtextEl) subtextEl.textContent = 'Processamento local direto no navegador';
    if (domainDot) domainDot.className = 'status-dot';
    updateButtonText();
  } else if (state === 'analisando') {
    if (mainBtn) {
      mainBtn.disabled = true;
      mainBtn.textContent = 'Analisando recursos...';
    }
    if (subtextEl) subtextEl.textContent = 'Compactação assíncrona com stream local';
    if (data?.subtitle) {
      const el = document.getElementById('analisandoSubtitle');
      if (el) el.textContent = data.subtitle;
    }
  } else if (state === 'baixando') {
    if (mainBtn) {
      mainBtn.disabled = true;
      mainBtn.textContent = 'Baixando...';
    }
    if (subtextEl) subtextEl.textContent = 'Processamento local em andamento';

    const bTitle = document.getElementById('baixandoTitle');
    const bSub = document.getElementById('baixandoSubtitle');
    const bPercent = document.getElementById('baixandoPercent');
    const bCount = document.getElementById('baixandoCount');
    const bFill = document.getElementById('baixandoProgressFill');
    const bList = document.getElementById('baixandoList');
    const bBoxTitle = document.getElementById('baixandoBoxTitle');
    const bBoxDesc = document.getElementById('baixandoBoxDesc');

    if (selectedModuleId === 'page-html') {
      if (bTitle) bTitle.textContent = 'Salvando documento HTML...';
      if (bSub) bSub.textContent = 'Higienizando DOM e preparando download direto';
      if (bPercent) bPercent.textContent = '100%';
      if (bCount) bCount.textContent = '1 de 1 item (100% íntegro)';
      if (bFill) bFill.style.width = '100%';
      if (bList) {
        bList.replaceChildren(
          createBaixandoRow(
            data?.filename || `${currentTabTitle || 'artigo-com'}.html`,
            'Concluído',
            undefined,
            'ok'
          )
        );
      }
      if (bBoxTitle) bBoxTitle.textContent = 'Arquivo HTML salvo na pasta local';
      if (bBoxDesc) bBoxDesc.textContent = 'Salvando diretamente na pasta Downloads sem travar o navegador.';
    } else {
      if (bTitle) bTitle.textContent = 'Empacotando e baixando arquivos...';
      if (bSub) bSub.textContent = 'Salvando no pacote sem congelar o navegador';
      const pct = data?.percent || (data?.total ? `${Math.round(((data.loaded || 0) / data.total) * 100)}%` : '0%');
      const count = data?.countText || (data?.total ? `${data.loaded || 0} de ${data.total} itens` : 'Preparando recursos...');
      if (bPercent) bPercent.textContent = pct;
      if (bCount) bCount.textContent = count;
      if (bFill) bFill.style.width = pct;
      if (bList) {
        if (data?.items && data.items.length > 0) {
          const rows = data.items.map((it: any) =>
            createBaixandoRow(
              it.name,
              it.status,
              it.state === 'active' ? 'accent' : (it.state === 'muted' ? 'muted' : undefined),
              it.state === 'active' ? 'active' : undefined
            )
          );
          bList.replaceChildren(...rows);
        } else if (data?.currentItem) {
          bList.replaceChildren(
            createBaixandoRow(data.currentItem, 'Processando...', 'accent', 'active')
          );
        } else {
          bList.replaceChildren();
        }
      }
      if (bBoxTitle) {
        bBoxTitle.textContent = data?.boxTitle || (data?.total ? `Progresso do pacote: ${data.loaded || 0} de ${data.total} arquivos salvos` : 'Salvando arquivos na pasta Downloads');
      }
      if (bBoxDesc) bBoxDesc.textContent = 'Salvando diretamente na pasta Downloads sem travar o navegador.';
    }
  } else if (state === 'pronto') {
    if (mainBtn) {
      mainBtn.disabled = false;
      mainBtn.textContent = selectedModuleId === 'page-html' ? 'Abrir arquivo .html' : 'Abrir arquivo ZIP';
    }
    if (subtextEl) subtextEl.textContent = 'Arquivo salvo na pasta padrão do navegador';

    const pFile = document.getElementById('prontoFilename');
    const pDetails = document.getElementById('prontoDetails');
    const pSub = document.getElementById('prontoSubtitle');
    const noticeBox = document.getElementById('prontoNoticeBox');
    const warnBox = document.getElementById('prontoWarnBox');

    if (pFile) pFile.textContent = data?.filename || (selectedModuleId === 'page-html' ? 'pagina.html' : 'pagina.zip');

    if (selectedModuleId === 'page-html') {
      if (pSub) pSub.textContent = 'Todos os recursos foram processados e salvos localmente';
      if (pDetails) pDetails.textContent = `${data?.size || '0 KB'} · 1 arquivo salvo · HTML`;
      if (noticeBox) noticeBox.style.display = 'block';
      if (warnBox) warnBox.style.display = 'none';
    } else {
      if (pSub) pSub.textContent = 'Todos os recursos foram processados e salvos localmente';
      if (pDetails) pDetails.textContent = `${data?.size || '0 KB'} · ${data?.itemCount || 0} arquivos salvos · ZIP`;
      if (noticeBox) noticeBox.style.display = 'none';
      if (data?.incomplete) {
        if (warnBox) warnBox.style.display = 'block';
      } else {
        if (warnBox) warnBox.style.display = 'none';
      }
    }

    const sumSaved = document.getElementById('sumSavedFiles');
    const sumIgnored = document.getElementById('sumIgnoredFiles');
    const sumTime = document.getElementById('sumElapsedTime');
    if (sumSaved) {
      sumSaved.textContent = selectedModuleId === 'page-html'
        ? '1 arquivo .html (100% íntegro)'
        : `${data?.itemCount || 0} arquivos salvos (${data?.incomplete ? 'parcial' : '100%'})`;
    }
    if (sumIgnored) {
      sumIgnored.textContent = data?.incomplete ? 'Recursos com CORS' : 'Nenhum';
    }
    if (sumTime && data?.elapsedTime) {
      sumTime.textContent = data.elapsedTime;
    }
  } else if (state === 'erro') {
    if (mainBtn) {
      mainBtn.disabled = true;
      mainBtn.textContent = 'Aguardando página compatível';
    }
    if (subtextEl) subtextEl.textContent = 'Mude para uma aba comum para reativar';
    if (domainDot) domainDot.className = 'status-dot muted';
    if (domainText) domainText.textContent = 'chrome://extens...';
  } else if (state === 'permissao') {
    if (mainBtn) {
      mainBtn.disabled = false;
      mainBtn.textContent = 'Conceder Permissão e Continuar';
    }
    if (subtextEl) subtextEl.textContent = 'Você pode revogar esta permissão a qualquer momento';
  } else if (state === 'login') {
    if (mainBtn) {
      mainBtn.disabled = false;
      mainBtn.textContent = 'Prosseguir com o Download (ZIP)';
    }
    if (subtextEl) subtextEl.textContent = 'Para cancelar, feche este painel a qualquer momento';
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
  updateButtonText();
  analyzeCurrentTab();
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
          if (domainText) domainText.textContent = u.hostname || 'localhost';
        } catch {
          currentTabOrigin = '';
        }

        const titleEl = document.getElementById('tabTitle');
        if (titleEl) titleEl.textContent = currentTabTitle;

        const urlEl = document.getElementById('tabUrl');
        if (urlEl) urlEl.textContent = currentTabUrl;

        const allowLocalhost = isLocalhostPage(currentTabUrl);
        const urlCheck = validateUrl(currentTabUrl, allowLocalhost);
        if (!urlCheck.valid) {
          setState('erro', { reason: urlCheck.reason });
        } else {
          analyzeCurrentTab();
        }
      }
    } catch (e) {
      console.warn('Não foi possível obter aba ativa no painel lateral:', e);
    }
  }
}

async function analyzeCurrentTab() {
  const currentModule = availableModules.find((m) => m.id === selectedModuleId);
  const itemsEl = document.getElementById('tabItems');
  if (!currentModule || !itemsEl) return;

  try {
    const analysis = await currentModule.analyze({
      tabId: currentTabId || undefined,
      url: currentTabUrl,
      title: currentTabTitle,
      html: targetTabOverrideHtml || ''
    });
    itemsEl.textContent = analysis.statusText || `${analysis.totalItems} itens`;
  } catch {
    itemsEl.textContent = 'Pronto para analisar';
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
          currentItem,
          countText: `${loaded} de ${total} itens`
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
          const urlEl = document.getElementById('tabUrl');
          if (urlEl) urlEl.textContent = tab.url;
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
        analyzeCurrentTab();
      }
    }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  renderModeCards();
  updateButtonText();
  updateActiveTab();

  const mainBtn = document.getElementById('mainActionBtn');
  if (mainBtn) {
    mainBtn.addEventListener('click', handleActionClick);
  }

  const cancelDownloadBtn = document.getElementById('cancelDownloadBtn');
  if (cancelDownloadBtn) {
    cancelDownloadBtn.addEventListener('click', () => {
      cleanupResources();
      setState('inicio');
    });
  }

  const openWindowBtn = document.getElementById('openWindowBtn');
  if (openWindowBtn) {
    openWindowBtn.addEventListener('click', () => {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({ type: 'OPEN_HORIZONTAL_WINDOW' });
      }
    });
  }
});
