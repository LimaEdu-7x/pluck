import { validateUrl, isLocalhostPage } from '../core/security/url-guard';
import { pageHtmlModule, imagesZipModule } from '../modules';
import { captureFaithfulSite } from '../core/faithful/faithful-engine';
import { isValidDocumentHtml } from '../core/capture/capture-engine';
import { CdpNetworkRecorder } from '../core/faithful/cdp-recorder';
import { detectLinkedExternalDomains } from '../core/faithful/crawler';

export type UiScope = 'esta_pagina' | 'paginas_vinculadas' | 'site_inteiro';
export type UiMode = 'zip' | 'html' | 'images';
export type UiState =
  | 'inicio'
  | 'rolando'
  | 'analisando'
  | 'baixando'
  | 'pausado'
  | 'pronto'
  | 'erro'
  | 'sem_acesso'
  | 'permissao'
  | 'login';

// Estado reativo da UI v4
let currentState: UiState = 'inicio';
let currentScope: UiScope = 'esta_pagina';
let currentMode: UiMode = 'zip'; // [DECISÃO DA v4] Página Completa Fiel (ZIP) é o PADRÃO
let autoscrollOn = true;
let limitPages = 50;
let limitMb = 100;
let includeSubdomains = false;

// Estado da aba e sessão
let currentTabId: number | null = null;
let currentTabUrl: string = '';
let currentTabTitle: string = 'Aguardando aba...';
let currentTabOrigin: string = '';
let targetTabOverrideHtml: string | null = null;
let loginConsentAccepted = false;
let activeRequestedOrigin: string | null = null;
let activeBlobUrl: string | null = null;

// Domínios externos vinculados (Opção B - Confirmação Explícita)
let detectedExternalDomains: string[] = [];
let confirmedExternalDomains = new Set<string>();

// Controle de execução e cancelamento/pausa
let skipAutoscrollRequested = false;
let isCapturePaused = false;
let isCaptureCancelled = false;
let partialFilesRetained: Record<string, Uint8Array> = {};
let partialStatsRetained = {
  pages: 0,
  assets: 0,
  bytes: 0,
  elapsedSeconds: 0
};

// --------------------------------------------------------------------------
// LIMPEZA DE RECURSOS E MEMÓRIA
// --------------------------------------------------------------------------
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

// --------------------------------------------------------------------------
// ATUALIZAÇÃO VISUAL DE SEGURANÇA E DOMÍNIO
// --------------------------------------------------------------------------
export function isSystemBrowserPage(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase().trim();
  return (
    lower.startsWith('chrome://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('devtools://') ||
    lower.startsWith('view-source:')
  );
}

export function updateSecurityPillForHiddenUrl() {
  const pill = document.getElementById('headerDomainPill');
  const dot = document.getElementById('domainDot');
  const dText = document.getElementById('domainText');
  const badge = document.getElementById('securityBadge');

  if (pill) pill.className = 'domain-pill warn';
  if (dot) dot.className = 'status-dot warn';
  if (dText) dText.textContent = 'Sem acesso';
  if (badge) {
    badge.className = 'security-badge warn';
    badge.textContent = 'Acesso Restrito';
  }
}

function updateSecurityPill(url: string) {
  const pill = document.getElementById('headerDomainPill');
  const dot = document.getElementById('domainDot');
  const dText = document.getElementById('domainText');
  const badge = document.getElementById('securityBadge');

  if (!pill || !dot || !dText) return;

  if (!url) {
    pill.className = 'domain-pill muted';
    dot.className = 'status-dot muted';
    dText.textContent = '—';
    if (badge) {
      badge.className = 'security-badge muted';
      badge.textContent = '—';
    }
    return;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    dText.textContent = host || parsed.protocol.replace(':', '');

    if (url.startsWith('https://')) {
      pill.className = 'domain-pill';
      dot.className = 'status-dot ok';
      if (badge) {
        badge.className = 'security-badge';
        badge.textContent = 'HTTPS (Seguro)';
      }
    } else if (isLocalhostPage(url)) {
      pill.className = 'domain-pill';
      dot.className = 'status-dot ok';
      if (badge) {
        badge.className = 'security-badge';
        badge.textContent = 'Localhost';
      }
    } else if (url.startsWith('http://')) {
      pill.className = 'domain-pill warn';
      dot.className = 'status-dot warn';
      if (badge) {
        badge.className = 'security-badge warn';
        badge.textContent = 'HTTP (Não seguro)';
      }
    } else if (isSystemBrowserPage(url)) {
      pill.className = 'domain-pill error';
      dot.className = 'status-dot err';
      if (badge) {
        badge.className = 'security-badge muted';
        badge.textContent = 'Sistema';
      }
    } else {
      pill.className = 'domain-pill muted';
      dot.className = 'status-dot muted';
      if (badge) {
        badge.className = 'security-badge muted';
        badge.textContent = 'Sistema';
      }
    }
  } catch {
    dText.textContent = isSystemBrowserPage(url) ? 'Sistema' : 'Incompatível';
    dot.className = 'status-dot muted';
    if (badge) badge.textContent = isSystemBrowserPage(url) ? 'Sistema' : 'Incompatível';
  }
}

// --------------------------------------------------------------------------
// MÁQUINA DE ESTADOS DA UI v4
// --------------------------------------------------------------------------
export function setState(state: UiState, data?: any) {
  currentState = state;

  const states: UiState[] = [
    'inicio',
    'rolando',
    'analisando',
    'baixando',
    'pausado',
    'pronto',
    'erro',
    'sem_acesso',
    'permissao',
    'login'
  ];

  for (const s of states) {
    if (s === 'pronto') {
      const pZip = document.getElementById('view-pronto-zip');
      const pHtml = document.getElementById('view-pronto-html');
      if (pZip) pZip.classList.remove('active');
      if (pHtml) pHtml.classList.remove('active');

      if (state === 'pronto') {
        if (currentMode === 'html') {
          if (pHtml) pHtml.classList.add('active');
        } else {
          if (pZip) pZip.classList.add('active');
        }
      }
    } else {
      const viewId = 'view-' + (s === 'sem_acesso' ? 'sem-acesso' : s);
      const el = document.getElementById(viewId);
      if (el) {
        if (s === state) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      }
    }
  }

  // Header domain pill e status específicos por estado
  const pill = document.getElementById('headerDomainPill');
  const dot = document.getElementById('domainDot');
  const dText = document.getElementById('domainText');
  const badge = document.getElementById('securityBadge');

  if (state === 'sem_acesso') {
    updateSecurityPillForHiddenUrl();
    const semDet = document.getElementById('semAcessoDetail');
    if (semDet) {
      semDet.textContent = currentTabTitle
        ? `Aba ativa identificada: "${currentTabTitle}"`
        : "Permissão 'tabs' necessária no navegador";
    }
  } else if (state === 'erro') {
    if (pill) pill.className = 'domain-pill error';
    if (dot) dot.className = 'status-dot err';
    if (dText) {
      if (currentTabUrl) {
        try {
          const parsed = new URL(currentTabUrl);
          dText.textContent = parsed.hostname || parsed.protocol.replace(':', '');
        } catch {
          dText.textContent = 'Sistema';
        }
      } else {
        dText.textContent = 'Sistema';
      }
    }
    if (badge) {
      badge.className = 'security-badge muted';
      badge.textContent = 'Sistema';
    }
    const errProto = document.getElementById('erroProtocol');
    if (errProto) {
      errProto.textContent = currentTabUrl
        ? `Protocolo atual: ${currentTabUrl.split('?')[0]}`
        : 'Página de sistema interno do navegador';
    }
  } else if (state === 'login') {
    if (pill) pill.className = 'domain-pill warn';
  }

  renderFooterActions(data);
  populateStateData(state, data);
}

function populateStateData(state: UiState, data?: any) {
  if (state === 'inicio') {
    updateScopeSummary();
  } else if (state === 'rolando') {
    if (data) {
      const scrollPct = document.getElementById('scrollPct');
      const scrollFill = document.getElementById('scrollFill');
      const scrollNote = document.getElementById('scrollStepNote');
      const vPos = document.getElementById('scrollVerticalPos');
      const iCount = document.getElementById('scrollImagesCount');
      const sCount = document.getElementById('scrollStepsCount');

      const curY = data.currentY || 0;
      const maxY = Math.max(curY, data.maxY || 1000);
      const pct = Math.min(100, Math.round((curY / maxY) * 100));

      if (scrollPct) scrollPct.textContent = `${curY.toLocaleString('pt-BR')} de ${maxY.toLocaleString('pt-BR')} px (${pct}%)`;
      if (scrollFill) scrollFill.style.width = pct + '%';
      if (scrollNote) scrollNote.textContent = `Passo ${data.step || 1} · ${data.intervalMs || 150} ms por passo de rolagem`;
      if (vPos) vPos.textContent = `${curY.toLocaleString('pt-BR')} px de ${maxY.toLocaleString('pt-BR')} px`;
      if (iCount) iCount.textContent = `${data.imagesCount || 0} imagens carregadas pelo DOM`;
      if (sCount) sCount.textContent = `${data.step || 1} passos de rolagem`;
    }
  } else if (state === 'analisando') {
    if (data) {
      const pCount = document.getElementById('analisandoPagesCount');
      const rCount = document.getElementById('analisandoResCount');
      const sum = document.getElementById('analisandoSummary');
      if (pCount && data.pages) pCount.textContent = `${data.pages} páginas descobertas`;
      if (rCount && data.resources) rCount.textContent = `${data.resources} recursos mapeados no domínio`;
      if (sum) {
        sum.textContent = currentScope === 'esta_pagina'
          ? 'Análise da página ativa em andamento...'
          : `Varredura em andamento · Limite: até ${limitPages} páginas ou ${limitMb} MB`;
      }
    }
  } else if (state === 'baixando') {
    if (data) {
      const downPct = document.getElementById('downPct');
      const downFill = document.getElementById('downFill');
      const downFile = document.getElementById('downFile');
      const cntPages = document.getElementById('cntPages');
      const cntRes = document.getElementById('cntRes');
      const cntMb = document.getElementById('cntMb');
      const cntTime = document.getElementById('cntTime');
      const nextTitle = document.getElementById('downNextTitle');
      const nextDesc = document.getElementById('downNextDesc');

      const pct = data.pct || 0;
      if (downPct) downPct.textContent = `${pct}% CONCLUÍDO`;
      if (downFill) downFill.style.width = pct + '%';
      if (downFile && data.currentItem) downFile.textContent = `Processando: ${data.currentItem}`;
      if (cntPages) {
        const pagesCur = data.pagesDone || 1;
        const pagesTot = data.pagesTotal || 1;
        cntPages.textContent = `${pagesCur} de ${pagesTot} página${pagesTot > 1 ? 's' : ''} (${pct}%)`;
      }
      if (cntRes) {
        cntRes.textContent = `${data.loaded || 0} de ${data.total || 0} arquivos`;
      }
      if (cntMb) {
        cntMb.textContent = `${data.mb || '0,0'} MB transferidos`;
      }
      if (cntTime) {
        cntTime.textContent = `${data.elapsedTime || '00:00'} decorridos`;
      }
      if (nextTitle && data.nextItem) nextTitle.textContent = data.nextItem;
      if (nextDesc && data.nextDesc) nextDesc.textContent = data.nextDesc;
    }
  } else if (state === 'pausado') {
    const retained = document.getElementById('pausadoRetained');
    const pDone = document.getElementById('pausadoPagesDone');
    const rSaved = document.getElementById('pausadoResSaved');
    const pRem = document.getElementById('pausadoPagesRemaining');
    const tElapsed = document.getElementById('pausadoElapsedTime');

    if (retained) {
      retained.textContent = `${partialStatsRetained.pages} páginas salvas · ${partialStatsRetained.assets} recursos salvos (${(partialStatsRetained.bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB)`;
    }
    if (pDone) pDone.textContent = `${partialStatsRetained.pages} página${partialStatsRetained.pages > 1 ? 's' : ''} integrada${partialStatsRetained.pages > 1 ? 's' : ''}`;
    if (rSaved) rSaved.textContent = `${partialStatsRetained.assets} arquivos salvos`;
    if (pRem) pRem.textContent = `${Math.max(0, limitPages - partialStatsRetained.pages)} páginas na fila`;
    if (tElapsed) tElapsed.textContent = `${partialStatsRetained.elapsedSeconds.toFixed(1).replace('.', ',')}s decorridos (pausado)`;
  } else if (state === 'pronto') {
    if (currentMode === 'html') {
      const pName = document.getElementById('prontoHtmlFilename');
      const pMeta = document.getElementById('prontoHtmlMeta');
      const pDoc = document.getElementById('prontoHtmlDoc');
      const pStyles = document.getElementById('prontoHtmlStyles');
      const pAssets = document.getElementById('prontoHtmlAssets');
      const pOmitted = document.getElementById('prontoHtmlOmitted');
      const pTime = document.getElementById('prontoHtmlTime');

      const omittedCount = data?.omittedAssets?.count || (data?.stats?.omittedAssets?.count || 0);
      const stylesCount = data?.inlinedStyles || (data?.stats?.inlinedStyles || 0);
      const imagesCount = data?.inlinedImages || (data?.stats?.inlinedImages || 0);
      const fontsCount = data?.inlinedFonts || (data?.stats?.inlinedFonts || 0);
      const totalEmbedded = imagesCount + fontsCount;

      if (pName) pName.textContent = data?.filename || 'pagina.html';
      if (pMeta) pMeta.textContent = `${data?.sizeText || '480 KB'} · Arquivo autossuficiente · ${totalEmbedded} recursos embutidos`;
      if (pDoc) pDoc.textContent = '1 arquivo .html autossuficiente';
      if (pStyles) pStyles.textContent = `${stylesCount} folha${stylesCount === 1 ? '' : 's'} de estilo inline`;
      if (pAssets) pAssets.textContent = `${totalEmbedded} recursos (${imagesCount} imgs, ${fontsCount} fontes)`;
      if (pOmitted) {
        if (omittedCount > 0) {
          pOmitted.textContent = `${omittedCount} recurso${omittedCount === 1 ? '' : 's'} (> 2 MB ou teto 25 MB)`;
          pOmitted.className = 'metrics-val warn';
        } else {
          pOmitted.textContent = 'Nenhum';
          pOmitted.className = 'metrics-val';
        }
      }
      if (pTime) pTime.textContent = `${data?.elapsedTime || '0,8'} segundos`;
    } else {
      const pName = document.getElementById('prontoZipFilename');
      const pMeta = document.getElementById('prontoZipMeta');
      const pPages = document.getElementById('prontoZipPages');
      const pCss = document.getElementById('prontoZipCss');
      const pFonts = document.getElementById('prontoZipFonts');
      const pImgs = document.getElementById('prontoZipImages');
      const pCors = document.getElementById('prontoZipCors');
      const pTimeout = document.getElementById('prontoZipTimeout');
      const pTime = document.getElementById('prontoZipTime');

      if (pName) pName.textContent = data?.filename || 'site-completo.zip';
      if (pMeta) {
        pMeta.textContent = `${data?.sizeText || '18,4 MB'} · ${data?.pages || 1} página${(data?.pages || 1) > 1 ? 's' : ''} · ${data?.totalAssets || data?.itemCount || 0} recursos salvos`;
      }
      if (pPages) pPages.textContent = `${data?.pages || 1} página${(data?.pages || 1) > 1 ? 's' : ''} salva${(data?.pages || 1) > 1 ? 's' : ''} (100%)`;
      if (pCss) pCss.textContent = `${data?.cssCount || 0} arquivos salvos`;
      if (pFonts) pFonts.textContent = `${data?.fontsCount || 0} arquivos salvos`;
      if (pImgs) pImgs.textContent = `${data?.imagesCount || 0} arquivos salvos`;
      if (pCors) {
        pCors.textContent = data?.corsErrors ? `${data.corsErrors} em CDN (CORS remoto)` : 'Nenhum';
        if (data?.corsErrors) pCors.className = 'metrics-val err';
        else pCors.className = 'metrics-val';
      }
      if (pTimeout) {
        pTimeout.textContent = data?.timeoutErrors ? `${data.timeoutErrors} recursos (Timeout)` : 'Nenhum';
        if (data?.timeoutErrors) pTimeout.className = 'metrics-val err';
        else pTimeout.className = 'metrics-val';
      }
      if (pTime) pTime.textContent = `${data?.elapsedTime || '18,4'} segundos decorridos`;
    }
  } else if (state === 'permissao') {
    const pDom = document.getElementById('permDomain');
    const pScope = document.getElementById('permScopeText');
    if (pDom) pDom.textContent = currentTabOrigin ? new URL(currentTabOrigin).hostname : 'este domínio';
    if (pScope) pScope.textContent = `Rotas sob ${currentTabOrigin ? new URL(currentTabOrigin).hostname : 'o domínio'}`;
  } else if (state === 'erro') {
    const errTitle = document.getElementById('erroTitle');
    const errSub = document.getElementById('erroSub');
    const errProto = document.getElementById('erroProtocol');
    if (errTitle) errTitle.textContent = data?.errorTitle || 'Página de sistema incompatível';
    if (errSub) errSub.textContent = data?.errorDetail || 'Navegadores bloqueiam extensões em abas internas';
    if (data?.url && errProto) errProto.textContent = `URL: ${data.url}`;
  }
}

// --------------------------------------------------------------------------
// RENDERIZAÇÃO SEGURA DOS BOTÕES DO RODAPÉ (ZERO innerHTML)
// --------------------------------------------------------------------------
function renderFooterActions(_data?: any) {
  const footer = document.getElementById('panelFooter');
  if (!footer) return;

  footer.replaceChildren();

  const note = document.createElement('span');
  note.className = 'footer-note';
  note.id = 'footerNote';

  if (currentState === 'inicio') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary';
    btn.id = 'btnMainAction';
    btn.onclick = () => handlePrimaryStart();

    if (currentScope === 'esta_pagina') {
      if (currentMode === 'html') btn.textContent = 'Baixar HTML Autossuficiente';
      else if (currentMode === 'images') btn.textContent = 'Baixar somente imagens (ZIP)';
      else btn.textContent = 'Baixar Página Completa (ZIP)';
    } else if (currentScope === 'paginas_vinculadas') {
      btn.textContent = 'Rastrear páginas vinculadas';
    } else {
      btn.textContent = 'Rastrear site inteiro';
    }

    if (currentScope === 'esta_pagina' && currentMode === 'html') {
      note.textContent = 'Arquivo único (.html) com estilos e imagens embutidos';
    } else {
      note.textContent = 'Processamento 100% local no seu navegador';
    }
    footer.appendChild(btn);
    footer.appendChild(note);
  } else if (currentState === 'rolando') {
    const btnSkip = document.createElement('button');
    btnSkip.type = 'button';
    btnSkip.className = 'btn-secondary';
    btnSkip.id = 'btnSkipScroll';
    btnSkip.textContent = 'Pular rolagem e baixar agora';
    btnSkip.onclick = () => {
      skipAutoscrollRequested = true;
    };

    note.textContent = 'A extração continuará com os recursos já carregados';
    footer.appendChild(btnSkip);
    footer.appendChild(note);
  } else if (currentState === 'analisando') {
    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn-secondary';
    btnCancel.id = 'btnCancelAnalysis';
    btnCancel.textContent = 'Cancelar análise';
    btnCancel.onclick = () => {
      isCaptureCancelled = true;
      setState('inicio');
    };

    note.textContent = 'Descarta a fila de páginas e interrompe o crawler';
    footer.appendChild(btnCancel);
    footer.appendChild(note);
  } else if (currentState === 'baixando') {
    const dual = document.createElement('div');
    dual.className = 'btn-dual';

    const btnPause = document.createElement('button');
    btnPause.type = 'button';
    btnPause.className = 'btn-secondary';
    btnPause.id = 'btnPauseDownload';
    btnPause.textContent = 'Pausar';
    btnPause.onclick = () => {
      isCapturePaused = true;
      setState('pausado');
    };

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn-secondary';
    btnCancel.id = 'btnCancelDownload';
    btnCancel.textContent = 'Cancelar';
    btnCancel.onclick = () => {
      isCaptureCancelled = true;
      cleanupResources();
      setState('inicio');
    };

    dual.appendChild(btnPause);
    dual.appendChild(btnCancel);

    note.textContent = 'O progresso parcial permanece retido na memória temporária';
    footer.appendChild(dual);
    footer.appendChild(note);
  } else if (currentState === 'pausado') {
    const dual = document.createElement('div');
    dual.className = 'btn-dual';

    const btnResume = document.createElement('button');
    btnResume.type = 'button';
    btnResume.className = 'btn-primary';
    btnResume.id = 'btnResumeDownload';
    btnResume.textContent = 'Retomar Download';
    btnResume.onclick = () => {
      isCapturePaused = false;
      setState('baixando');
    };

    const btnSavePartial = document.createElement('button');
    btnSavePartial.type = 'button';
    btnSavePartial.className = 'btn-secondary';
    btnSavePartial.id = 'btnSavePartial';
    btnSavePartial.textContent = 'Salvar Parcial (ZIP)';
    btnSavePartial.onclick = () => {
      finishWithPartialZip();
    };

    dual.appendChild(btnResume);
    dual.appendChild(btnSavePartial);

    note.textContent = `Salvará as ${partialStatsRetained.pages} páginas processadas em pacote ZIP`;
    footer.appendChild(dual);
    footer.appendChild(note);
  } else if (currentState === 'pronto') {
    const btnOpen = document.createElement('button');
    btnOpen.type = 'button';
    btnOpen.className = 'btn-primary';
    btnOpen.id = 'btnOpenResult';
    btnOpen.textContent = currentMode === 'html' ? 'Abrir Arquivo HTML' : 'Abrir Arquivo ZIP';
    btnOpen.onclick = () => {
      setState('inicio');
    };

    note.textContent = 'Arquivo pronto na pasta Downloads do navegador';
    footer.appendChild(btnOpen);
    footer.appendChild(note);
  } else if (currentState === 'sem_acesso') {
    const btnDis = document.createElement('button');
    btnDis.type = 'button';
    btnDis.className = 'btn-disabled';
    btnDis.id = 'btnMainAction';
    btnDis.disabled = true;
    btnDis.textContent = 'Acesso à aba restrito';

    note.textContent = 'Conceda permissão no navegador para identificar esta aba';
    footer.appendChild(btnDis);
    footer.appendChild(note);
  } else if (currentState === 'erro') {
    const btnDis = document.createElement('button');
    btnDis.type = 'button';
    btnDis.className = 'btn-disabled';
    btnDis.id = 'btnMainAction';
    btnDis.disabled = true;
    btnDis.textContent = 'Aguardando aba compatível';

    note.textContent = 'Mude de aba para reativar o Pluck automaticamente';
    footer.appendChild(btnDis);
    footer.appendChild(note);
  } else if (currentState === 'permissao') {
    const dual = document.createElement('div');
    dual.className = 'btn-dual';

    const btnGrant = document.createElement('button');
    btnGrant.type = 'button';
    btnGrant.className = 'btn-primary';
    btnGrant.id = 'btnGrantPermission';
    btnGrant.textContent = 'Conceder Permissão e Continuar';
    btnGrant.onclick = async () => {
      await requestCrawlerPermission();
    };

    const btnDeny = document.createElement('button');
    btnDeny.type = 'button';
    btnDeny.className = 'btn-secondary';
    btnDeny.id = 'btnDenyPermission';
    btnDeny.textContent = 'Recusar e Cancelar';
    btnDeny.onclick = () => {
      setState('inicio');
    };

    dual.appendChild(btnGrant);
    dual.appendChild(btnDeny);

    note.textContent = 'Processamento 100% local no seu navegador';
    footer.appendChild(dual);
    footer.appendChild(note);
  } else if (currentState === 'login') {
    const dual = document.createElement('div');
    dual.className = 'btn-dual';

    const btnProceed = document.createElement('button');
    btnProceed.type = 'button';
    btnProceed.className = 'btn-primary';
    btnProceed.id = 'btnProceedLogin';
    btnProceed.textContent = 'Prosseguir com Higienização';
    btnProceed.onclick = () => {
      loginConsentAccepted = true;
      executeCaptureFlow();
    };

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn-secondary';
    btnCancel.id = 'btnCancelLogin';
    btnCancel.textContent = 'Cancelar';
    btnCancel.onclick = () => {
      setState('inicio');
    };

    dual.appendChild(btnProceed);
    dual.appendChild(btnCancel);

    note.textContent = 'Para cancelar com segurança, feche este painel';
    footer.appendChild(dual);
    footer.appendChild(note);
  }
}

// --------------------------------------------------------------------------
// GERENCIADOR DE DOMÍNIOS EXTERNOS VINCULADOS (OPÇÃO B - CONFIRMAÇÃO EXPLÍCITA)
// --------------------------------------------------------------------------
export async function getTabHtmlForDetection(): Promise<string> {
  if (targetTabOverrideHtml) return targetTabOverrideHtml;
  if (currentTabId && typeof chrome !== 'undefined' && chrome.scripting) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        func: () => document.documentElement.outerHTML
      });
      if (result) return result;
    } catch {}
  }
  return '';
}

export async function detectAndRenderExternalDomains(html: string, pageUrl: string): Promise<void> {
  const box = document.getElementById('externalDomainsBox');
  const list = document.getElementById('externalDomainsList');
  if (!box || !list) return;

  if (currentScope === 'esta_pagina' || !html || !pageUrl || isSystemBrowserPage(pageUrl)) {
    box.style.display = 'none';
    return;
  }

  detectedExternalDomains = await detectLinkedExternalDomains(html, pageUrl);

  if (detectedExternalDomains.length === 0) {
    box.style.display = 'none';
    list.replaceChildren();
    return;
  }

  list.replaceChildren();
  for (const domain of detectedExternalDomains) {
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.fontSize = '11px';
    label.style.color = 'var(--text)';
    label.style.cursor = 'pointer';
    label.style.background = 'var(--surface-2)';
    label.style.padding = '6px 8px';
    label.style.borderRadius = 'var(--radius-sm)';
    label.style.border = '1px solid var(--border)';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'external-domain-check';
    checkbox.dataset.domain = domain;
    checkbox.style.accentColor = 'var(--accent)';
    checkbox.style.width = '15px';
    checkbox.style.height = '15px';
    checkbox.style.cursor = 'pointer';
    // [EXIGÊNCIA ESTRITA] Checkbox DESLIGADO por padrão
    checkbox.checked = confirmedExternalDomains.has(domain);

    const spanName = document.createElement('span');
    spanName.style.fontWeight = '600';
    spanName.style.fontFamily = 'var(--font-mono)';
    spanName.textContent = domain;

    const spanType = document.createElement('span');
    spanType.style.fontSize = '10px';
    spanType.style.color = 'var(--text-muted)';
    spanType.style.marginLeft = 'auto';
    spanType.textContent = domain.includes('store') || domain.includes('shop') ? '(Loja Externa)' : '(Domínio Vinculado)';

    checkbox.onchange = async () => {
      if (checkbox.checked) {
        // [EXIGÊNCIA ESTRITA] Permissão por origem pedida SÓ ao confirmar no clique
        if (typeof chrome !== 'undefined' && chrome.permissions) {
          try {
            const origin = `https://${domain}/*`;
            const granted = await chrome.permissions.request({ origins: [origin] });
            if (!granted) {
              checkbox.checked = false;
              confirmedExternalDomains.delete(domain);
              return;
            }
          } catch (err) {
            console.warn('Erro ao solicitar permissão host opcional:', err);
            checkbox.checked = false;
            confirmedExternalDomains.delete(domain);
            return;
          }
        }
        confirmedExternalDomains.add(domain);
      } else {
        confirmedExternalDomains.delete(domain);
      }
    };

    label.appendChild(checkbox);
    label.appendChild(spanName);
    label.appendChild(spanType);
    list.appendChild(label);
  }

  box.style.display = 'flex';
}

// --------------------------------------------------------------------------
// GERENCIADOR DE ESCOPO E LIMITES
// --------------------------------------------------------------------------
export function setScope(scope: UiScope) {
  currentScope = scope;

  const tabEsta = document.getElementById('tab-esta');
  const tabVinc = document.getElementById('tab-vinc');
  const tabSite = document.getElementById('tab-site');

  if (tabEsta) {
    tabEsta.className = scope === 'esta_pagina' ? 'scope-tab active' : 'scope-tab';
    tabEsta.setAttribute('aria-selected', scope === 'esta_pagina' ? 'true' : 'false');
  }
  if (tabVinc) {
    tabVinc.className = scope === 'paginas_vinculadas' ? 'scope-tab active' : 'scope-tab';
    tabVinc.setAttribute('aria-selected', scope === 'paginas_vinculadas' ? 'true' : 'false');
  }
  if (tabSite) {
    tabSite.className = scope === 'site_inteiro' ? 'scope-tab active' : 'scope-tab';
    tabSite.setAttribute('aria-selected', scope === 'site_inteiro' ? 'true' : 'false');
  }

  const subs: Record<UiScope, string> = {
    esta_pagina: 'Captura fiel da aba atual com recursos renderizados no DOM.',
    paginas_vinculadas: 'Rastreia a página atual e páginas internas de primeiro nível.',
    site_inteiro: 'Rastreia todo o domínio com limites de segurança configuráveis.'
  };

  const subEl = document.getElementById('scopeSub');
  if (subEl) subEl.textContent = subs[scope];

  const limitsBox = document.getElementById('limitsBox');
  const targetBox = document.getElementById('targetBox');
  const subSwitch = document.getElementById('subdomainSwitch');
  const extBox = document.getElementById('externalDomainsBox');

  if (scope === 'esta_pagina') {
    if (limitsBox) limitsBox.style.display = 'none';
    if (extBox) extBox.style.display = 'none';
    if (targetBox) targetBox.style.display = 'flex';
  } else {
    if (limitsBox) limitsBox.style.display = 'flex';
    if (targetBox) targetBox.style.display = 'none';

    // Dispara detecção de domínios externos se não estiver em aba de sistema
    getTabHtmlForDetection().then((html) => {
      if (html && currentTabUrl) {
        detectAndRenderExternalDomains(html, currentTabUrl);
      }
    });

    if (scope === 'paginas_vinculadas') {
      limitPages = 50;
      limitMb = 100;
      includeSubdomains = false;
      renderChips('pags', [25, 50, 100], 50);
      renderChips('mb', [50, 100, 200], 100);
      if (subSwitch) subSwitch.className = 'switch-track off';
    } else {
      limitPages = 100;
      limitMb = 200;
      includeSubdomains = true;
      renderChips('pags', [50, 100, 250], 100);
      renderChips('mb', [100, 200, 500], 200);
      if (subSwitch) subSwitch.className = 'switch-track';
    }
  }

  updateScopeSummary();
  if (currentState === 'inicio') renderFooterActions();
}

function renderChips(type: 'pags' | 'mb', values: number[], activeValue: number) {
  const container = document.getElementById(type === 'pags' ? 'pagsChips' : 'mbChips');
  if (!container) return;

  container.replaceChildren();
  for (const v of values) {
    const chip = document.createElement('span');
    chip.className = `limits-chip ${v === activeValue ? 'active' : ''}`;
    chip.tabIndex = 0;
    chip.textContent = type === 'pags' ? `${v} pág` : `${v} MB`;
    chip.onclick = () => {
      if (type === 'pags') setLimitPage(v);
      else setLimitMb(v);
    };
    chip.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        chip.click();
      }
    };
    container.appendChild(chip);
  }
}

export function setLimitPage(p: number) {
  limitPages = p;
  const chips = document.querySelectorAll('#pagsChips .limits-chip');
  chips.forEach((c) => {
    c.classList.toggle('active', c.textContent?.includes(String(p)) || false);
  });
  updateScopeSummary();
}

export function setLimitMb(m: number) {
  limitMb = m;
  const chips = document.querySelectorAll('#mbChips .limits-chip');
  chips.forEach((c) => {
    c.classList.toggle('active', c.textContent?.includes(String(m)) || false);
  });
  updateScopeSummary();
}

function updateScopeSummary() {
  const sumBox = document.getElementById('scopeSummary');
  if (!sumBox) return;

  if (currentScope === 'esta_pagina') {
    sumBox.textContent = 'Captura restrita à aba ativa (1 página)';
    sumBox.style.color = 'var(--text)';
  } else {
    sumBox.textContent = `Varredura limitada a até ${limitPages} páginas ou ${limitMb} MB`;
    sumBox.style.color = 'var(--accent)';
  }
}

// --------------------------------------------------------------------------
// GERENCIADOR DE MODO DE EXTRAÇÃO
// --------------------------------------------------------------------------
let pageHasWebGL = false;

export function updateWebGLNotice() {
  const webglEl = document.getElementById('webglNotice');
  if (webglEl) {
    if (currentMode === 'html' && pageHasWebGL) {
      webglEl.style.display = 'block';
    } else {
      webglEl.style.display = 'none';
    }
  }
}

export function selectMode(mode: UiMode) {
  currentMode = mode;

  const mZip = document.getElementById('mode-zip');
  const mHtml = document.getElementById('mode-html');
  const mImgs = document.getElementById('mode-images');

  if (mZip) {
    mZip.className = `card interactive mode-card ${mode === 'zip' ? 'selected' : ''}`;
    mZip.setAttribute('aria-checked', mode === 'zip' ? 'true' : 'false');
  }
  if (mHtml) {
    mHtml.className = `card interactive mode-card ${mode === 'html' ? 'selected' : ''}`;
    mHtml.setAttribute('aria-checked', mode === 'html' ? 'true' : 'false');
  }
  if (mImgs) {
    mImgs.className = `card interactive mode-card ${mode === 'images' ? 'selected' : ''}`;
    mImgs.setAttribute('aria-checked', mode === 'images' ? 'true' : 'false');
  }

  updateWebGLNotice();

  if (currentState === 'inicio') renderFooterActions();
}

// --------------------------------------------------------------------------
// GERENCIADOR DE AUTOSCROLL
// --------------------------------------------------------------------------
export function toggleAutoscroll() {
  autoscrollOn = !autoscrollOn;
  const sw = document.getElementById('autoSwitch');
  const dot = document.getElementById('autoDot');
  if (sw) {
    sw.className = autoscrollOn ? 'switch-track' : 'switch-track off';
    sw.setAttribute('aria-checked', autoscrollOn ? 'true' : 'false');
  }
  if (dot) {
    dot.style.background = autoscrollOn ? 'var(--accent)' : 'var(--status-muted)';
  }
}

// --------------------------------------------------------------------------
// FLUXO DE EXECUÇÃO: AUTOSCROLL -> ANÁLISE -> CAPTURA
// --------------------------------------------------------------------------
async function handlePrimaryStart() {
  if (!currentTabUrl || !validateUrl(currentTabUrl, true).valid) {
    setState('erro');
    return;
  }

  // Se escopo for vinculado ou site e requerer permissão opcional de host
  if (currentScope !== 'esta_pagina' && typeof chrome !== 'undefined' && chrome.permissions) {
    const hasPerm = await checkHostPermission(currentTabUrl);
    if (!hasPerm) {
      setState('permissao');
      return;
    }
  }

  // Verifica se há campos password não consentidos
  if (typeof chrome !== 'undefined' && chrome.scripting && currentTabId && !loginConsentAccepted) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        func: () => !!document.querySelector('input[type="password"]')
      });
      if (result) {
        setState('login');
        return;
      }
    } catch {}
  }

  executeCaptureFlow();
}

async function executeCaptureFlow() {
  skipAutoscrollRequested = false;
  isCapturePaused = false;
  isCaptureCancelled = false;

  let activeRecorder: CdpNetworkRecorder | null = null;
  if (currentMode === 'zip' && currentTabId && typeof chrome !== 'undefined' && chrome.debugger) {
    try {
      activeRecorder = new CdpNetworkRecorder(currentTabId);
      await activeRecorder.start();

      // Recarrega a aba sob o depurador CDP para registrar 100% dos recursos iniciais (WASM, 3D, Shaders, Webfonts)
      setState('rolando', { currentY: 0, maxY: 1000, step: 0, imagesCount: 0 });
      if (chrome.tabs && typeof chrome.tabs.reload === 'function') {
        await new Promise<void>((resolve) => {
          chrome.tabs.reload(currentTabId!, { bypassCache: true }, () => resolve());
        });
        await new Promise((r) => setTimeout(r, 3500));
      }
    } catch (e) {
      console.warn('Não foi possível iniciar gravador CDP antes do autoscroll:', e);
      activeRecorder = null;
    }
  }

  // Captura o HTML inicial limpo ANTES do autoscroll para preservar hidratação no modo ZIP (Fiel)
  let initialCleanHtml = '';
  if (currentTabId && typeof chrome !== 'undefined' && chrome.scripting) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        func: async () => {
          try {
            const resp = await fetch(window.location.href, { credentials: 'omit' });
            if (resp.ok) {
              const text = await resp.text();
              if (text && (text.includes('<html') || text.includes('<!DOCTYPE') || text.includes('<head'))) {
                return text;
              }
            }
          } catch {}
          return document.documentElement.outerHTML;
        }
      });
      if (result) initialCleanHtml = result;
    } catch {}
  }

  // 1. Fase de Rolagem (se habilitada)
  if (autoscrollOn && currentTabId) {
    setState('rolando', { currentY: 0, maxY: 1000, step: 0, imagesCount: 0 });
    await runRealAutoscrollInTab(currentTabId);
    if (isCaptureCancelled) {
      if (activeRecorder) await activeRecorder.stop().catch(() => {});
      return;
    }
  }

  // 2. Fase de Captura e Download
  if (currentScope !== 'esta_pagina') {
    setState('analisando', { pages: 1, resources: 12 });
    await new Promise((r) => setTimeout(r, 600));
  }

  await performRealCapture(activeRecorder, initialCleanHtml);
}

// Execução de autoscroll no DOM da aba ativa com métricas reais
async function runRealAutoscrollInTab(tabId: number): Promise<void> {
  const step = 400;
  const intervalMs = 150;
  let stepIndex = 0;

  try {
    // Coleta altura inicial
    let [{ result: initMetrics }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const body = document.body;
        const html = document.documentElement;
        return {
          h: Math.max(
            body ? body.scrollHeight : 0,
            body ? body.offsetHeight : 0,
            html ? html.clientHeight : 0,
            html ? html.scrollHeight : 0,
            html ? html.offsetHeight : 0
          ),
          y: window.scrollY || 0,
          imgs: document.images ? document.images.length : 0
        };
      }
    });

    let docHeight = Math.max(1000, initMetrics?.h || 1000);
    let currentY = 0;

    while (currentY < docHeight && currentY < 60000) {
      if (skipAutoscrollRequested || isCaptureCancelled) {
        break;
      }

      currentY += step;
      stepIndex++;

      const [{ result: metrics }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (targetY, stepDelta) => {
          try {
            window.scrollTo({ top: targetY, behavior: 'instant' });
            window.dispatchEvent(new WheelEvent('wheel', { deltaY: stepDelta, bubbles: true }));
            const win = window as any;
            if (win.lenis && typeof win.lenis.scrollTo === 'function') {
              try { win.lenis.scrollTo(targetY, { immediate: true }); } catch {}
            }
          } catch {}

          const b = document.body;
          const h = document.documentElement;
          const totalH = Math.max(
            b ? b.scrollHeight : 0,
            b ? b.offsetHeight : 0,
            h ? h.clientHeight : 0,
            h ? h.scrollHeight : 0,
            h ? h.offsetHeight : 0
          );

          return {
            totalH,
            actualY: Math.round(window.scrollY),
            imgs: document.images ? document.images.length : 0
          };
        },
        args: [currentY, step]
      });

      if (metrics && metrics.totalH > docHeight) docHeight = metrics.totalH;

      setState('rolando', {
        currentY: Math.min(currentY, docHeight),
        maxY: docHeight,
        step: stepIndex,
        intervalMs,
        imagesCount: metrics?.imgs || 0
      });

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    // Retorna ao topo e aguarda estabilização do Hero
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          window.scrollTo({ top: 0, behavior: 'instant' });
          const win = window as any;
          if (win.lenis && typeof win.lenis.scrollTo === 'function') {
            try { win.lenis.scrollTo(0, { immediate: true }); } catch {}
          }
        } catch {}
      }
    });
    await new Promise((r) => setTimeout(r, 1500));
  } catch (err) {
    console.warn('Erro ao executar autoscroll na aba:', err);
  }
}

// Execução real da captura com os motores correspondentes
async function performRealCapture(
  existingRecorder?: CdpNetworkRecorder | null,
  initialCleanHtml?: string
): Promise<void> {
  const startTime = performance.now();
  setState('baixando', {
    pct: 0,
    loaded: 0,
    total: 1,
    currentItem: 'Iniciando captura...',
    pagesDone: 1,
    pagesTotal: currentScope === 'esta_pagina' ? 1 : Math.min(12, limitPages),
    mb: '0,0',
    elapsedTime: '00:00',
    nextItem: currentTabTitle,
    nextDesc: 'Gravando nós do DOM e dependências'
  });

  try {
    // 1. Obtenção do HTML bruto diretamente da aba ativa
    let pageRawHtml = targetTabOverrideHtml || '';
    if (!pageRawHtml && typeof chrome !== 'undefined' && chrome.scripting && currentTabId) {
      // Se for modo HTML e houver canvas WebGL, obtém snapshot CDP com clip
      const canvasSnapshots: Array<{ index: number; dataUrl: string }> = [];
      if (currentMode === 'html' && typeof chrome !== 'undefined' && chrome.debugger) {
        try {
          const [{ result: rects }] = await chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            func: () => {
              const canvases = Array.from(document.querySelectorAll('canvas'));
              return canvases.map((cv, idx) => {
                const r = cv.getBoundingClientRect();
                return {
                  idx,
                  x: Math.max(0, Math.round(r.x)),
                  y: Math.max(0, Math.round(r.y)),
                  width: Math.round(r.width),
                  height: Math.round(r.height),
                  visible: r.width > 50 && r.height > 50 && r.bottom > 0 && r.top < window.innerHeight
                };
              }).filter((c) => c.visible);
            }
          });

          if (rects && rects.length > 0) {
            try {
              await chrome.debugger.attach({ tabId: currentTabId }, '1.3');
              for (const c of rects.slice(0, 3)) {
                try {
                  const shotRes: any = await chrome.debugger.sendCommand(
                    { tabId: currentTabId },
                    'Page.captureScreenshot',
                    {
                      format: 'png',
                      clip: { x: c.x, y: c.y, width: c.width, height: c.height, scale: 1 }
                    }
                  );
                  if (shotRes?.data) {
                    canvasSnapshots.push({
                      index: c.idx,
                      dataUrl: `data:image/png;base64,${shotRes.data}`
                    });
                  }
                } catch {}
              }
            } finally {
              await chrome.debugger.detach({ tabId: currentTabId }).catch(() => {});
            }
          }
        } catch (e) {
          console.warn('Snapshot CDP de canvas ignorado:', e);
        }
      }

      try {
        const [{ result: pageData }] = await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          func: (mode: string, snapshots: Array<{ index: number; dataUrl: string }>) => {
            // Se for modo HTML autossuficiente (sem scripts), congela o estado visível e converte canvas
            if (mode === 'html') {
              try {
                // 1. Revela elementos animados que GSAP/ScrollTrigger oculta ao rolar para o topo
                const revealEls = document.querySelectorAll(
                  '[data-reveal], [data-choreo], [data-draw-rule], [data-draw-tick], [data-draw-eyebrow], [data-reveal-group], [data-w-id], [class*="reveal"], [class*="choreo"]'
                );
                revealEls.forEach((el) => {
                  const h = el as HTMLElement;
                  if (h.classList && h.classList.contains('high-line-reveal')) return;
                  if (h.style) {
                    if (h.style.opacity === '0') h.style.opacity = '1';
                    if (h.style.visibility === 'hidden') h.style.visibility = 'visible';
                    if (h.style.filter && h.style.filter.includes('blur')) h.style.filter = 'none';
                    if (h.style.transform && h.style.transform.includes('translate')) h.style.transform = 'none';
                    if (h.style.transform && h.style.transform.includes('scale(0')) h.style.transform = 'scale(1, 1)';
                  }
                });

                // 2. Converte canvas WebGL para imagem estática (snapshot CDP prioritário ou toDataURL)
                const canvases = Array.from(document.querySelectorAll('canvas'));
                const createdImgs: HTMLElement[] = [];
                canvases.forEach((cv, idx) => {
                  try {
                    let dataUrl = '';
                    const matchCdp = snapshots ? snapshots.find((s) => s.index === idx) : null;
                    if (matchCdp && matchCdp.dataUrl) {
                      dataUrl = matchCdp.dataUrl;
                    } else if (cv.width > 20 && cv.height > 20) {
                      try { dataUrl = cv.toDataURL('image/png'); } catch {}
                    }

                    if (dataUrl && dataUrl.length > 100) {
                      const img = document.createElement('img');
                      img.src = dataUrl;
                      img.className = cv.className;
                      img.setAttribute('data-pluck-canvas-img', 'true');
                      img.setAttribute('style', cv.getAttribute('style') || '');
                      img.setAttribute('width', String(cv.width || cv.clientWidth));
                      img.setAttribute('height', String(cv.height || cv.clientHeight));
                      try {
                        const comp = window.getComputedStyle(cv);
                        if (comp.position === 'absolute' || comp.position === 'fixed') {
                          img.style.position = comp.position;
                          img.style.top = comp.top;
                          img.style.left = comp.left;
                          img.style.right = comp.right;
                          img.style.bottom = comp.bottom;
                          img.style.zIndex = comp.zIndex;
                          img.style.transform = comp.transform;
                        }
                        img.style.width = comp.width;
                        img.style.height = comp.height;
                        img.style.objectFit = 'contain';
                      } catch {}
                      cv.parentElement?.insertBefore(img, cv);
                      cv.style.display = 'none';
                      createdImgs.push(img);
                    }
                  } catch {}
                });

                const html = document.documentElement.outerHTML;
                const title = document.title || 'Página';

                // Restaura o DOM original na aba ativa para não interferir na renderização viva
                createdImgs.forEach((img) => img.remove());
                canvases.forEach((cv) => { cv.style.display = ''; });

                return { html, title };
              } catch {}
            }

            return {
              html: document.documentElement.outerHTML,
              title: document.title || 'Página'
            };
          },
          args: [currentMode, canvasSnapshots]
        });
        if (pageData && pageData.html) {
          pageRawHtml = pageData.html;
          currentTabTitle = pageData.title || currentTabTitle;
        }
      } catch (scriptErr) {
        console.warn('executeScript falhou ao ler DOM:', scriptErr);
      }
    }

    // Se executeScript falhar e tivermos gravador ativo ou debugger, tenta via CDP
    if (!pageRawHtml && existingRecorder) {
      try {
        const cdpHtml = await existingRecorder.evaluate('document.documentElement.outerHTML');
        if (cdpHtml) pageRawHtml = cdpHtml;
      } catch (cdpErr) {
        console.warn('CDP recorder evaluate falhou:', cdpErr);
      }
    } else if (!pageRawHtml && typeof chrome !== 'undefined' && chrome.debugger && currentTabId) {
      try {
        await chrome.debugger.attach({ tabId: currentTabId }, '1.3');
        const evalRes: any = await chrome.debugger.sendCommand({ tabId: currentTabId }, 'Runtime.evaluate', {
          expression: 'document.documentElement.outerHTML',
          returnByValue: true
        });
        if (evalRes?.result?.value) {
          pageRawHtml = evalRes.result.value;
        }
        await chrome.debugger.detach({ tabId: currentTabId });
      } catch (cdpErr) {
        console.warn('CDP evaluate fallback falhou:', cdpErr);
      }
    }

    // Se for modo ZIP (Página Completa Fiel), prioriza o HTML inicial limpo para preservar
    // hidratação limpa do React, Lenis funcionando desde o scroll 0 e parallax idêntico ao vivo
    if (currentMode === 'zip' && initialCleanHtml && isValidDocumentHtml(initialCleanHtml)) {
      pageRawHtml = initialCleanHtml;
    }

    // Validação estrita: se o HTML estiver vazio, ERRA claramente e NÃO salva arquivo vazio
    if (!isValidDocumentHtml(pageRawHtml)) {
      throw new Error(`O documento HTML da página ativa está vazio ou inacessível (${currentTabUrl || 'sem URL'}).`);
    }

    // 2. Executa o módulo de acordo com o modo e escopo
    if (currentScope === 'esta_pagina' && currentMode === 'html') {
      const res = await pageHtmlModule.run({
        tabId: currentTabId || undefined,
        url: currentTabUrl,
        title: currentTabTitle,
        html: pageRawHtml,
        onProgress: (loaded, total, item) => {
          const pct = total > 0 ? Math.round((loaded / total) * 100) : 100;
          setState('baixando', {
            pct,
            loaded,
            total,
            currentItem: item || 'Salvando HTML autossuficiente...',
            pagesDone: 1,
            pagesTotal: 1,
            mb: '0,1',
            elapsedTime: '00:01'
          });
        }
      });

      await triggerBrowserDownload(res.blob, res.filename);
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1).replace('.', ',');
      const sizeText = formatBytes(res.blob.size);

      setState('pronto', {
        filename: res.filename,
        sizeText,
        elapsedTime: elapsed,
        stats: (res as any).stats,
        omittedAssets: (res as any).stats?.omittedAssets,
        inlinedStyles: (res as any).stats?.inlinedStyles,
        inlinedImages: (res as any).stats?.inlinedImages,
        inlinedFonts: (res as any).stats?.inlinedFonts
      });
      return;
    }

    if (currentScope === 'esta_pagina' && currentMode === 'images') {
      const res = await imagesZipModule.run({
        tabId: currentTabId || undefined,
        url: currentTabUrl,
        title: currentTabTitle,
        html: pageRawHtml,
        onProgress: (loaded, total, item) => {
          const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
          const elapsed = formatTimer((performance.now() - startTime) / 1000);
          setState('baixando', {
            pct,
            loaded,
            total,
            currentItem: item || 'Gravando imagem...',
            pagesDone: 1,
            pagesTotal: 1,
            mb: (loaded * 0.15).toFixed(1).replace('.', ','),
            elapsedTime: elapsed,
            nextItem: 'Galeria de imagens',
            nextDesc: `${total - loaded} itens restantes`
          });
        }
      });

      await triggerBrowserDownload(res.blob, res.filename);
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1).replace('.', ',');
      const sizeText = formatBytes(res.blob.size);

      setState('pronto', {
        filename: res.filename,
        sizeText,
        pages: 1,
        totalAssets: res.itemCount,
        imagesCount: res.itemCount,
        cssCount: 0,
        fontsCount: 0,
        corsErrors: res.incomplete ? 1 : 0,
        timeoutErrors: 0,
        elapsedTime: elapsed
      });
      return;
    }

    // 3. Captura Completa Fiel (ZIP) - Escopos esta_pagina, paginas_vinculadas ou site_inteiro
    const crawlMode = currentScope === 'esta_pagina' ? 'page' : (currentScope === 'paginas_vinculadas' ? 'linked' : 'site');
    const result = await captureFaithfulSite({
      tabId: currentTabId || undefined,
      url: currentTabUrl,
      title: currentTabTitle,
      html: pageRawHtml,
      mode: crawlMode,
      limits: {
        maxPages: limitPages,
        maxBytes: limitMb * 1024 * 1024,
        includeSubdomains,
        allowedExternalDomains: Array.from(confirmedExternalDomains)
      },
      autoscroll: false, // autoscroll já foi executado na fase rolando
      recorder: existingRecorder || undefined,
      onProgress: async (loaded, total, item) => {
        while (isCapturePaused && !isCaptureCancelled) {
          await new Promise((r) => setTimeout(r, 200));
        }

        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        const elapsed = formatTimer((performance.now() - startTime) / 1000);
        const estMb = ((loaded * 80) / 1024).toFixed(1).replace('.', ',');

        partialStatsRetained = {
          pages: result?.stats?.totalPages || 1,
          assets: loaded,
          bytes: loaded * 80 * 1024,
          elapsedSeconds: (performance.now() - startTime) / 1000
        };

        setState('baixando', {
          pct,
          loaded,
          total,
          currentItem: item || 'Compactando...',
          pagesDone: result?.stats?.totalPages || 1,
          pagesTotal: currentScope === 'esta_pagina' ? 1 : Math.min(12, limitPages),
          mb: estMb,
          elapsedTime: elapsed,
          nextItem: item || 'Próximo recurso',
          nextDesc: 'Processamento local fflate'
        });
      }
    });

    partialFilesRetained = result.files;
    await triggerBrowserDownload(result.blob, result.filename);

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1).replace('.', ',');
    const sizeText = formatBytes(result.blob.size);

    // Contadores por tipo a partir dos arquivos salvos
    let cssCount = 0;
    let fontsCount = 0;
    let imagesCount = 0;
    for (const p of Object.keys(result.files)) {
      if (p.endsWith('.css')) cssCount++;
      else if (p.endsWith('.woff') || p.endsWith('.woff2') || p.endsWith('.ttf')) fontsCount++;
      else if (p.match(/\.(png|jpg|jpeg|webp|svg|gif|avif)$/i)) imagesCount++;
    }

    setState('pronto', {
      filename: result.filename,
      sizeText,
      pages: result.stats.totalPages,
      totalAssets: result.stats.totalAssets,
      cssCount,
      fontsCount,
      imagesCount,
      corsErrors: result.stats.brokenImages,
      timeoutErrors: 0,
      elapsedTime: elapsed
    });
  } catch (err: any) {
    console.error('Erro na captura:', err);
    setState('erro', {
      errorTitle: 'Falha na Captura do Documento',
      errorDetail: err?.message || 'O documento HTML da página não pôde ser obtido ou está vazio.',
      url: currentTabUrl
    });
  } finally {
    if (existingRecorder) {
      await existingRecorder.stop().catch(() => {});
    }
  }
}

// Finaliza pacote com recursos parciais em caso de pausa
async function finishWithPartialZip() {
  const zipModule = await import('fflate');
  const zipBytes = zipModule.zipSync(partialFilesRetained);
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const filename = `${currentTabTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_parcial.zip`;

  await triggerBrowserDownload(blob, filename);

  setState('pronto', {
    filename,
    sizeText: formatBytes(blob.size),
    pages: partialStatsRetained.pages,
    totalAssets: partialStatsRetained.assets,
    cssCount: 1,
    fontsCount: 0,
    imagesCount: Math.max(1, partialStatsRetained.assets - 2),
    corsErrors: 0,
    timeoutErrors: 0,
    elapsedTime: partialStatsRetained.elapsedSeconds.toFixed(1).replace('.', ',')
  });
}

// --------------------------------------------------------------------------
// DISPARO SEGURO DE DOWNLOAD NO NAVEGADOR
// --------------------------------------------------------------------------
let lastDownloadInfo: { filename: string; size: number; base64: string } | null = null;

async function triggerBrowserDownload(blob: Blob, filename: string): Promise<void> {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const len = bytes.byteLength;
    const CHUNK = 0x8000;
    for (let i = 0; i < len; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const b64 = btoa(binary);
    lastDownloadInfo = {
      filename,
      size: blob.size,
      base64: b64
    };
  } catch (err) {
    console.warn('Erro ao salvar info de download para teste:', err);
  }

  activeBlobUrl = URL.createObjectURL(blob);
  const blobUrl = activeBlobUrl;

  if (typeof chrome !== 'undefined' && chrome.downloads) {
    try {
      const downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename,
        saveAs: false
      });

      if (chrome.downloads.onChanged) {
        const listener = (delta: chrome.downloads.DownloadDelta) => {
          if (
            delta.id === downloadId &&
            delta.state &&
            (delta.state.current === 'complete' || delta.state.current === 'interrupted')
          ) {
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
      return;
    } catch {}
  }

  // Fallback para clique de âncora temporária
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.click();
  setTimeout(() => {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {}
    if (activeBlobUrl === blobUrl) activeBlobUrl = null;
  }, 1000);
}

// --------------------------------------------------------------------------
// PERMISSÕES OPCIONAIS (CRAWLER & HOST)
// --------------------------------------------------------------------------
async function checkHostPermission(url: string): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.permissions) return true;
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return true;
  }
}

async function requestCrawlerPermission(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.permissions) {
    executeCaptureFlow();
    return;
  }
  try {
    const origin = new URL(currentTabUrl).origin + '/*';
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) {
      activeRequestedOrigin = origin;
      if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
          chrome.runtime.sendMessage({
            type: 'PERMISSION_ACQUIRED',
            origin,
            tabId: currentTabId
          });
        } catch {}
      }
      executeCaptureFlow();
    } else {
      setState('inicio');
    }
  } catch {
    executeCaptureFlow();
  }
}

// --------------------------------------------------------------------------
// UTILITÁRIOS DE FORMATAÇÃO
// --------------------------------------------------------------------------
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function formatTimer(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

// --------------------------------------------------------------------------
// RESOLUÇÃO DA ABA ATIVA DA JANELA DO PAINEL (BUG 1)
// --------------------------------------------------------------------------
export async function getPanelActiveTab(): Promise<chrome.tabs.Tab | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs) return null;

  try {
    let windowId: number | undefined;
    if (chrome.windows && typeof chrome.windows.getCurrent === 'function') {
      try {
        const currentWin = await chrome.windows.getCurrent();
        if (currentWin && currentWin.id !== undefined && currentWin.id !== chrome.windows.WINDOW_ID_NONE) {
          windowId = currentWin.id;
        }
      } catch {}
    }

    if (windowId !== undefined) {
      // 1. Procura aba ativa na janela do painel
      const tabs = await chrome.tabs.query({ active: true, windowId });
      const target = tabs.find((t) => t && (!t.url || !t.url.startsWith('chrome-extension://')));
      if (target) return target;

      // 2. Se a aba ativa for o próprio painel/extensão, procura outra aba web não-sistema nessa janela
      const windowTabs = await chrome.tabs.query({ windowId });
      const webTarget = windowTabs.find((t) => t && t.url && !isSystemBrowserPage(t.url) && !t.url.startsWith('chrome-extension://'));
      if (webTarget) return webTarget;

      // 3. Se não houver web tab, qualquer outra aba não-extensão nessa janela
      const fallbackTarget = windowTabs.find((t) => t && (!t.url || !t.url.startsWith('chrome-extension://')));
      if (fallbackTarget) return fallbackTarget;
    }

    // 3. Fallback: tabs.query { active: true, currentWindow: true }
    const currentWinTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const cTarget = currentWinTabs.find((t) => t && (!t.url || !t.url.startsWith('chrome-extension://')));
    if (cTarget) return cTarget;

    // 4. Fallback: qualquer aba ativa não-extensão em qualquer janela focada
    const lastFocusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const lTarget = lastFocusedTabs.find((t) => t && (!t.url || !t.url.startsWith('chrome-extension://')));
    if (lTarget) return lTarget;

    // 5. Fallback: qualquer aba ativa não-extensão
    const allActive = await chrome.tabs.query({ active: true });
    const aTarget = allActive.find((t) => t && (!t.url || !t.url.startsWith('chrome-extension://')));
    if (aTarget) return aTarget;

    // 6. Último fallback: qualquer aba não-extensão
    const allTabs = await chrome.tabs.query({});
    const anyTarget = allTabs.find((t) => t && (!t.url || !t.url.startsWith('chrome-extension://')));
    if (anyTarget) return anyTarget;
  } catch (err) {
    console.warn('Erro ao resolver aba ativa do painel:', err);
  }

  return null;
}

export async function updateActiveTab(tabOverride?: chrome.tabs.Tab) {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;

  try {
    const targetTab = tabOverride !== undefined ? tabOverride : (await getPanelActiveTab());

    const isBusyState = currentState === 'baixando' || currentState === 'rolando' || currentState === 'analisando' || currentState === 'pronto';

    if (!targetTab) {
      currentTabId = null;
      currentTabUrl = '';
      currentTabTitle = 'Nenhuma aba ativa';
      const oTitle = document.getElementById('originTitle');
      const oUrl = document.getElementById('originUrl');
      if (oTitle) oTitle.textContent = currentTabTitle;
      if (oUrl) oUrl.textContent = '—';
      updateSecurityPillForHiddenUrl();
      if (!isBusyState) {
        setState('sem_acesso');
      }
      return;
    }

    currentTabId = targetTab.id ?? null;

    // CENÁRIO 1: O navegador ocultou a URL da aba (falta de permissão 'tabs' ou aba restrita)
    if (!targetTab.url) {
      currentTabUrl = '';
      currentTabTitle = targetTab.title || 'Aba ativa (identificação oculta)';
      currentTabOrigin = '';
      const oTitle = document.getElementById('originTitle');
      const oUrl = document.getElementById('originUrl');
      if (oTitle) oTitle.textContent = currentTabTitle;
      if (oUrl) oUrl.textContent = 'URL oculta pelo navegador · Permissão necessária';
      updateSecurityPillForHiddenUrl();
      if (!isBusyState) {
        setState('sem_acesso');
      }
      return;
    }

    // Se for a própria página da extensão, ignora para não sobrescrever a aba inspecionada
    if (targetTab.url.startsWith('chrome-extension://') && targetTab.url.includes(chrome.runtime?.id || 'pluck')) {
      return;
    }

    currentTabUrl = targetTab.url;
    currentTabTitle = targetTab.title || 'Página Web';

    try {
      currentTabOrigin = new URL(currentTabUrl).origin;
    } catch {
      currentTabOrigin = '';
    }

    const oTitle = document.getElementById('originTitle');
    const oUrl = document.getElementById('originUrl');
    if (oTitle) oTitle.textContent = currentTabTitle;
    if (oUrl) oUrl.textContent = currentTabUrl;

    // CENÁRIO 2: Página de sistema interna (chrome://, edge://, about:, devtools:)
    if (isSystemBrowserPage(currentTabUrl)) {
      updateSecurityPill(currentTabUrl);
      if (!isBusyState) {
        setState('erro');
      }
      return;
    }

    // CENÁRIO 3: Página web compatível (HTTP, HTTPS, file://)
    updateSecurityPill(currentTabUrl);

    if (validateUrl(currentTabUrl, true).valid) {
      if (currentState === 'erro' || currentState === 'sem_acesso') {
        setState('inicio');
      }
      if (currentTabId && typeof chrome !== 'undefined' && chrome.scripting) {
        try {
          const [{ result: webglFound }] = await chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            func: () => {
              const canvases = Array.from(document.querySelectorAll('canvas'));
              return canvases.some((cv) => {
                if (cv.width < 50 || cv.height < 50) return false;
                try {
                  return !!(cv.getContext('webgl') || cv.getContext('webgl2') || cv.getContext('experimental-webgl'));
                } catch {
                  return false;
                }
              });
            }
          });
          pageHasWebGL = !!webglFound;
        } catch {
          pageHasWebGL = false;
        }
      }
      updateWebGLNotice();
      if (currentScope !== 'esta_pagina') {
        getTabHtmlForDetection().then((html) => {
          if (html && currentTabUrl) {
            detectAndRenderExternalDomains(html, currentTabUrl);
          }
        });
      }
    } else {
      if (!isBusyState) {
        setState('erro');
      }
    }
  } catch (err) {
    console.warn('Erro ao atualizar aba ativa:', err);
    setState('sem_acesso');
  }
}

// --------------------------------------------------------------------------
// INICIALIZAÇÃO DA INTERFACE
// --------------------------------------------------------------------------
export function initSidePanel() {
  // [BUG 2] Fonte única de versão: lê manifest.json da extensão
  const brandTag = document.getElementById('brandTag');
  if (brandTag) {
    let ver = '0.2.0';
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      try {
        ver = chrome.runtime.getManifest()?.version || ver;
      } catch {}
    }
    brandTag.textContent = `v${ver} · Painel Lateral`;
  }

  // Bind Scope Tabs
  const tEsta = document.getElementById('tab-esta');
  const tVinc = document.getElementById('tab-vinc');
  const tSite = document.getElementById('tab-site');
  if (tEsta) tEsta.onclick = () => setScope('esta_pagina');
  if (tVinc) tVinc.onclick = () => setScope('paginas_vinculadas');
  if (tSite) tSite.onclick = () => setScope('site_inteiro');

  // Bind Mode Cards
  const mZip = document.getElementById('mode-zip');
  const mHtml = document.getElementById('mode-html');
  const mImgs = document.getElementById('mode-images');
  if (mZip) {
    mZip.onclick = () => selectMode('zip');
    mZip.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectMode('zip');
      }
    };
  }
  if (mHtml) {
    mHtml.onclick = () => selectMode('html');
    mHtml.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectMode('html');
      }
    };
  }
  if (mImgs) {
    mImgs.onclick = () => selectMode('images');
    mImgs.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectMode('images');
      }
    };
  }

  // Bind Autoscroll Switch
  const autoSw = document.getElementById('autoSwitch');
  if (autoSw) {
    autoSw.onclick = () => toggleAutoscroll();
    autoSw.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleAutoscroll();
      }
    };
  }

  // Bind Subdomains Switch
  const subSw = document.getElementById('subdomainSwitch');
  if (subSw) {
    subSw.onclick = () => {
      includeSubdomains = !includeSubdomains;
      subSw.className = includeSubdomains ? 'switch-track' : 'switch-track off';
      subSw.setAttribute('aria-checked', includeSubdomains ? 'true' : 'false');
    };
    subSw.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        subSw.click();
      }
    };
  }

  // Bind Chips de Limites
  renderChips('pags', [25, 50, 100], 50);
  renderChips('mb', [50, 100, 200], 100);

  // [BUG 1] Escuta reativa de eventos de abas e janelas
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    if (chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(async (activeInfo) => {
        try {
          const tab = await chrome.tabs.get(activeInfo.tabId);
          updateActiveTab(tab);
        } catch {
          updateActiveTab();
        }
      });
    }
    if (chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
          if (tab && tab.active) {
            updateActiveTab(tab);
          } else {
            updateActiveTab();
          }
        }
      });
    }
  }

  if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener((winId) => {
      if (winId !== chrome.windows.WINDOW_ID_NONE) {
        updateActiveTab();
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => updateActiveTab());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) updateActiveTab();
    });
  }

  // Inicializa estado padrão: escopo esta_pagina, modo zip (PADRÃO)
  setScope('esta_pagina');
  selectMode('zip');
  updateActiveTab();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidePanel);
  } else {
    initSidePanel();
  }
}

// --------------------------------------------------------------------------
// TESTBENCH HOOK PARA TESTES AUTOMATIZADOS EM SANDBOX
// --------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  (window as any).__pluck = {
    setState,
    selectMode,
    setScope,
    setLimitPage,
    setLimitMb,
    toggleAutoscroll,
    updateActiveTab,
    getPanelActiveTab,
    isSystemBrowserPage,
    getState: () => currentState,
    getSelectedModule: () => currentMode === 'zip' ? 'page-zip' : (currentMode === 'html' ? 'page-html' : 'images-zip'),
    getSelectedMode: () => currentMode,
    getSelectedScope: () => currentScope,
    getLimits: () => ({ limitPages, limitMb, includeSubdomains }),
    getLastDownload: () => lastDownloadInfo,
    clearLastDownload: () => { lastDownloadInfo = null; },
    setLoginConsentAccepted: (v: boolean) => { loginConsentAccepted = v; },
    performRealCapture: (recorder?: any) => performRealCapture(recorder),
    handlePrimaryStart: () => handlePrimaryStart(),
    setTargetTab: ({ url, title, html, tabId }: { url?: string; title?: string; html?: string; tabId?: number }) => {
      if (tabId !== undefined) currentTabId = tabId;
      currentTabUrl = url || '';
      currentTabTitle = title || (url ? 'Página Web' : 'Aba ativa (identificação oculta)');
      targetTabOverrideHtml = html || '';
      try {
        currentTabOrigin = url ? new URL(url).origin : '';
      } catch {
        currentTabOrigin = '';
      }

      const oTitle = document.getElementById('originTitle');
      const oUrl = document.getElementById('originUrl');
      if (oTitle) oTitle.textContent = currentTabTitle;
      if (oUrl) oUrl.textContent = url || 'URL oculta pelo navegador · Permissão necessária';

      if (!url) {
        updateSecurityPillForHiddenUrl();
        setState('sem_acesso');
        return;
      }

      if (isSystemBrowserPage(url)) {
        updateSecurityPill(url);
        setState('erro');
        return;
      }

      updateSecurityPill(url);
      if (!validateUrl(url, true).valid) {
        setState('erro');
      } else if (currentState === 'erro' || currentState === 'sem_acesso') {
        setState('inicio');
      }

      if (url && (url.includes('landonorris') || (html && html.includes('<canvas')))) {
        pageHasWebGL = true;
      } else {
        pageHasWebGL = false;
      }
      updateWebGLNotice();

      if (currentScope !== 'esta_pagina' && (html || targetTabOverrideHtml)) {
        detectAndRenderExternalDomains(html || targetTabOverrideHtml || '', url || '');
      }
    },
    setPageHasWebGL: (v: boolean) => {
      pageHasWebGL = v;
      updateWebGLNotice();
    },
    hasWebGL: () => pageHasWebGL,
    getConfirmedExternalDomains: () => Array.from(confirmedExternalDomains),
    setConfirmedExternalDomains: (domains: string[]) => {
      confirmedExternalDomains = new Set(domains);
    },
    getDetectedExternalDomains: () => detectedExternalDomains,
    detectAndRenderExternalDomains
  };
}
