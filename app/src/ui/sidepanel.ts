import { validateUrl, isLocalhostPage, classifyTabAccess } from '../core/security/url-guard';
import { pageHtmlModule } from '../modules';
import { captureFaithfulSite } from '../core/faithful/faithful-engine';
import { isValidDocumentHtml } from '../core/capture/capture-engine';
import { CdpNetworkRecorder } from '../core/faithful/cdp-recorder';
import { detectLinkedExternalDomains } from '../core/faithful/crawler';
import { isSpaSkeleton, serializeLiveDom } from '../core/faithful/dom-serializer';
import { SessionRecorder } from '../core/faithful/session-recorder';
import { CapturedResource } from '../core/faithful/types';
import type { AutoscrollOptions } from '../core/faithful/autoscroll';
import { captureMediaZip, collectMediaFromDom, type MediaType } from '../core/capture/media-collector';
import { watchTargetTab, type TabGuard } from '../core/faithful/tab-guard';

export type UiScope = 'esta_pagina' | 'paginas_vinculadas' | 'site_inteiro';
export type UiMode = 'zip' | 'html' | 'images';
export type UiState =
  | 'inicio'
  | 'opcoes'
  | 'rolando'
  | 'analisando'
  | 'baixando'
  | 'pausado'
  | 'pronto'
  | 'sem_acesso'
  | 'erro'
  | 'permissao'
  | 'login'
  | 'gravando'
  | 'gravacao_erro';

// Estado reativo da UI v12
let currentState: UiState = 'inicio';
let currentScope: UiScope = 'esta_pagina';
let currentMode: UiMode = 'zip'; // [DECISÃO DA v4/v12] Página Completa Fiel (ZIP) é o PADRÃO
let captureMethod: 'automatic' | 'recording' = 'automatic'; // SPEC-v12: Automático vs Gravação
const sessionRecorder = new SessionRecorder();
let recordingTimerInterval: any = null;
let autoscrollOn = true;
let scrollLimitChoice: '10' | '30' | 'unlimited' = '10';

export function setScrollLimitChoice(val: '10' | '30' | 'unlimited') {
  scrollLimitChoice = val;
  const cards = [
    { el: document.getElementById('scrollCardScreens'), key: '10' },
    { el: document.getElementById('scrollCardTime'), key: '30' },
    { el: document.getElementById('scrollCardUnlimited'), key: 'unlimited' }
  ];
  cards.forEach(({ el, key }) => {
    if (!el) return;
    const isSelected = key === val;
    el.className = isSelected ? 'card interactive mode-card selected' : 'card interactive mode-card';
    el.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    el.tabIndex = isSelected ? 0 : -1;
    const radio = el.querySelector('.radio-circle');
    if (radio) {
      if (isSelected) {
        radio.className = 'radio-circle active';
        radio.innerHTML = '<div class="radio-dot"></div>';
      } else {
        radio.className = 'radio-circle';
        radio.innerHTML = '';
      }
    }
  });

  const scrollChips = document.querySelectorAll('#scrollLimitChips .chip-option');
  scrollChips.forEach((chip) => {
    const chipVal = chip.getAttribute('data-val');
    const isChipActive =
      (val === '10' && chipVal === '10') ||
      (val === '30' && chipVal === '30') ||
      (val === 'unlimited' && (chipVal === '999' || chipVal === 'unlimited'));
    chip.classList.toggle('active', isChipActive);
    chip.setAttribute('aria-checked', isChipActive ? 'true' : 'false');
    (chip as HTMLElement).tabIndex = isChipActive ? 0 : -1;
  });
}

export function getActiveAutoscrollOptions(): AutoscrollOptions {
  if (scrollLimitChoice === '30') {
    return {
      limitType: 'time',
      maxTimeSeconds: 30, // SPEC-v12: 30 segundos
      step: 400,
      intervalMs: 150
    };
  }
  if (scrollLimitChoice === 'unlimited') {
    return {
      limitType: 'unlimited',
      step: 400,
      intervalMs: 150
    };
  }
  return {
    limitType: 'screens',
    maxScreens: 10,
    step: 400,
    intervalMs: 150
  };
}
let limitPages = 50;
let limitDepth = 2;
let limitMb = 100;
let includeSubdomains = false;
let recordingStartTime: number | null = null;

// Estado da aba e sessão
let currentTabId: number | null = null;
let currentTabUrl: string = '';
let currentTabTitle: string = 'Aguardando aba...';
let currentTabOrigin: string = '';
let targetTabOverrideHtml: string | null = null;
let loginConsentAccepted = false;
let activeRequestedOrigin: string | null = null;
let activeBlobUrl: string | null = null;
let lastDownloadInfo: { filename: string; size: number; base64: string } | null = null;
let inMemoryArchivedFile: { filename: string; blob: Blob; base64: string } | null = null;

// Preserva a aba e origem travadas no início da captura ou gravação
let lockedCaptureTabId: number | null = null;
let lockedCaptureUrl: string | null = null;
let lockedCaptureTitle: string | null = null;
let lockedCaptureOrigin: string | null = null;

export function getLockedCaptureZipFilename(): string {
  const base = lockedCaptureTitle || (lockedCaptureUrl ? new URL(lockedCaptureUrl).hostname : '') || 'site';
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${clean || 'site'}-fiel.zip`;
}

// Domínios externos vinculados (Opção B - Confirmação Explícita)
let detectedExternalDomains: string[] = [];
let confirmedExternalDomains = new Set<string>();

function isActionKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space';
}

// Controle de execução e cancelamento/pausa
let skipAutoscrollRequested = false;
let requestSkipCurrentRequested = false;
let requestStopAndSaveRequested = false;
let isCapturePaused = false;
let isCaptureCancelled = false;
let isCapturing = false;
let lastErrorData: any = null;

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
// REINICIALIZAÇÃO PARA TELA INICIAL (SEM FECHAR O PAINEL)
// --------------------------------------------------------------------------
export function resetToInitialState() {
  // 1. Interrompe qualquer captura/autoscroll em andamento e limpa recursos/permissões
  isCaptureCancelled = true;
  isCapturePaused = false;
  skipAutoscrollRequested = false;
  cleanupResources();

  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  sessionRecorder.reset();

  // 2. Limpa dados de progresso e resultado anterior (SPEC-v12: arquivo apagado ao clicar em Voltar)
  lastDownloadInfo = null;
  inMemoryArchivedFile = null;
  requestSkipCurrentRequested = false;
  requestStopAndSaveRequested = false;
  lockedCaptureTabId = null;
  lockedCaptureUrl = null;
  lockedCaptureTitle = null;
  lockedCaptureOrigin = null;

  // Limpa elementos visuais de progresso e métricas no DOM
  const scrollPct = document.getElementById('scrollPct');
  if (scrollPct) scrollPct.textContent = '0 de 0 px (0%)';
  const scrollFill = document.getElementById('scrollFill');
  if (scrollFill) scrollFill.style.width = '0%';
  const scrollStepNote = document.getElementById('scrollStepNote');
  if (scrollStepNote) scrollStepNote.textContent = 'Iniciando rolagem suave do DOM...';
  const scrollVerticalPos = document.getElementById('scrollVerticalPos');
  if (scrollVerticalPos) scrollVerticalPos.textContent = '0 px de 0 px';
  const scrollImagesCount = document.getElementById('scrollImagesCount');
  if (scrollImagesCount) scrollImagesCount.textContent = '0 imagens carregadas pelo DOM';
  const scrollStepsCount = document.getElementById('scrollStepsCount');
  if (scrollStepsCount) scrollStepsCount.textContent = '0 passos de rolagem';

  const downPct = document.getElementById('downPct');
  if (downPct) downPct.textContent = '0% CONCLUÍDO';
  const downFill = document.getElementById('downFill');
  if (downFill) {
    downFill.style.width = '0%';
    downFill.classList.remove('complete');
  }
  const downProgressbar = document.getElementById('downProgressbar');
  if (downProgressbar) downProgressbar.setAttribute('aria-valuenow', '0');
  lastAnnouncedMilestone = -1;
  const downFile = document.getElementById('downFile');
  if (downFile) downFile.textContent = 'Iniciando captura de recursos...';
  const cntPages = document.getElementById('cntPages');
  if (cntPages) cntPages.textContent = '1 de 1 página (100%)';
  const cntRes = document.getElementById('cntRes');
  if (cntRes) cntRes.textContent = '0 de 0 arquivos';
  const cntMb = document.getElementById('cntMb');
  if (cntMb) cntMb.textContent = '0,0 MB transferidos';
  const cntTime = document.getElementById('cntTime');
  if (cntTime) cntTime.textContent = '00:00 decorridos';

  // 3. Volta para o estado inicial padrão, mantendo a aba/URL ativa
  captureMethod = 'automatic';
  autoscrollOn = true;
  const autoSw = document.getElementById('autoSwitch');
  const recSw = document.getElementById('recordClicksSwitch');
  if (autoSw) {
    autoSw.className = 'switch-track';
    autoSw.setAttribute('aria-checked', 'true');
  }
  if (recSw) {
    recSw.className = 'switch-track off';
    recSw.setAttribute('aria-checked', 'false');
  }

  const autoCircle = document.getElementById('autoRadioCircle');
  const recCircle = document.getElementById('recRadioCircle');
  const optAuto = document.getElementById('optAutoRow');
  const optRec = document.getElementById('optRecRow');
  if (autoCircle) {
    autoCircle.classList.add('active');
    autoCircle.innerHTML = '<div class="radio-dot"></div>';
  }
  if (recCircle) {
    recCircle.classList.remove('active');
    recCircle.innerHTML = '';
  }
  if (optAuto) {
    optAuto.classList.add('selected');
    optAuto.setAttribute('aria-checked', 'true');
  }
  if (optRec) {
    optRec.classList.remove('selected');
    optRec.setAttribute('aria-checked', 'false');
  }

  setScope('esta_pagina');
  selectMode('zip');
  setState('inicio');

  // Permite que uma nova captura seja executada
  isCaptureCancelled = false;
  isCapturing = false;
  lastErrorData = null;
}

// --------------------------------------------------------------------------
// ATUALIZAÇÃO VISUAL DE SEGURANÇA E DOMÍNIO
// --------------------------------------------------------------------------
export interface PageAccessibility {
  accessible: boolean;
  reason?: string;
  shortLabel?: string;
}

export function checkPageAccessibility(url?: string | null, title?: string | null): PageAccessibility {
  const isPdf = Boolean(
    (title && title.toLowerCase().trim().endsWith('.pdf')) ||
    (url && url.toLowerCase().includes('.pdf'))
  );
  const kind = classifyTabAccess(url, isPdf ? 'application/pdf' : undefined);

  switch (kind) {
    case 'loja':
      return {
        accessible: false,
        reason: 'Loja de extensões não permite captura',
        shortLabel: 'Loja de extensões não permite captura'
      };
    case 'arquivo_local':
      return {
        accessible: false,
        reason: 'Arquivo local',
        shortLabel: 'Arquivo local'
      };
    case 'pdf':
      return {
        accessible: false,
        reason: 'PDF não suportado',
        shortLabel: 'PDF não suportado'
      };
    case 'sistema':
    case 'vazio':
      return {
        accessible: false,
        reason: 'Página protegida do navegador',
        shortLabel: 'Página protegida do navegador'
      };
    case 'ok':
      return { accessible: true };
  }
}

export function isSystemBrowserPage(url: string): boolean {
  if (!url) return false;
  const kind = classifyTabAccess(url);
  return kind === 'sistema' || kind === 'vazio';
}

export function formatDisplayDomain(urlOrOrigin?: string | null): string {
  if (!urlOrOrigin || urlOrOrigin === 'null' || urlOrOrigin === 'undefined' || urlOrOrigin === '—' || urlOrOrigin === 'about:blank') {
    return 'Sem página';
  }
  const access = checkPageAccessibility(urlOrOrigin, currentTabTitle);
  if (!access.accessible) {
    return access.reason!;
  }
  try {
    const parsed = new URL(urlOrOrigin);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host && host !== 'null' && host !== 'undefined') return host;
    const proto = parsed.protocol.replace(':', '');
    if (proto && proto !== 'null' && proto !== 'undefined') return proto;
  } catch {
    const cleaned = urlOrOrigin.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
    if (cleaned && cleaned !== 'null' && cleaned !== 'undefined') return cleaned;
  }
  return 'Sem página';
}

export function updateSecurityPillForHiddenUrl() {
  const pill = document.getElementById('headerDomainPill');
  const dot = document.getElementById('domainDot');
  const ring = document.getElementById('domainRing');
  const dText = document.getElementById('domainText');
  const badge = document.getElementById('securityBadge');

  if (pill) pill.className = 'site-chip domain-pill warn';
  if (dot) dot.className = 'status-dot dot-core-amber warn';
  if (ring) ring.className = 'ring-spin-amber';
  if (dText) dText.textContent = 'Sem acesso';
  if (badge) {
    badge.className = 'security-badge warn';
    badge.textContent = 'Acesso Restrito';
  }
}

function updateSecurityPill(url: string, tabStatus?: string) {
  const pill = document.getElementById('headerDomainPill');
  const dot = document.getElementById('domainDot');
  const ring = document.getElementById('domainRing');
  const dText = document.getElementById('domainText');
  const badge = document.getElementById('securityBadge');
  const popUrl = document.getElementById('popover-full-url');
  const popStatus = document.getElementById('popover-status-text');
  const savePath = document.getElementById('saveFolderPath');

  if (!pill || !dot || !dText) return;

  if (popUrl) popUrl.textContent = url || '—';

  const isBusyState = currentState === 'baixando' || currentState === 'rolando' || currentState === 'analisando' || currentState === 'pronto';

  const access = checkPageAccessibility(url, currentTabTitle);
  if (!access.accessible) {
    pill.className = 'site-chip domain-pill error';
    dot.className = 'status-dot dot-core-red err';
    if (ring) ring.className = 'ring-static-red';
    dText.textContent = access.reason!;
    if (badge) {
      badge.className = 'security-badge muted';
      badge.textContent = access.reason!;
    }
    if (popStatus) {
      popStatus.replaceChildren();
      const mDot = document.createElement('span');
      mDot.className = 'mini-dot';
      mDot.style.background = '#EF4444';
      mDot.style.boxShadow = '0 0 6px #EF4444';
      popStatus.appendChild(mDot);
      popStatus.appendChild(document.createTextNode(' PÁGINA RESTRITA'));
      popStatus.style.color = '#EF4444';
    }
    return;
  }

  if (!url || url === 'null' || url === 'undefined') {
    if (isBusyState) {
      // Regra do Sinal / DESIGN.md: O chip do topo mantém o domínio sendo capturado, nunca "Sem página" no meio da captura
      return;
    }
    pill.className = 'site-chip domain-pill muted';
    dot.className = 'status-dot dot-core-red err';
    if (ring) ring.className = 'ring-static-red';
    dText.textContent = 'Sem página';
    if (badge) {
      badge.className = 'security-badge muted';
      badge.textContent = 'Sem página';
    }
    if (popStatus) {
      popStatus.replaceChildren();
      const mDot = document.createElement('span');
      mDot.className = 'mini-dot';
      mDot.style.background = '#EF4444';
      mDot.style.boxShadow = '0 0 6px #EF4444';
      popStatus.appendChild(mDot);
      popStatus.appendChild(document.createTextNode(' SEM PÁGINA'));
      popStatus.style.color = '#EF4444';
    }
    return;
  }

  try {
    const cleanHost = formatDisplayDomain(url);
    dText.textContent = cleanHost;

    if (savePath) {
      savePath.textContent = `Downloads / ${cleanHost !== 'Sem página' ? cleanHost : 'site'}.zip`;
    }

    if (isSystemBrowserPage(url)) {
      pill.className = 'site-chip domain-pill error';
      dot.className = 'status-dot dot-core-red err';
      if (ring) ring.className = 'ring-static-red';
      if (badge) {
        badge.className = 'security-badge muted';
        badge.textContent = 'Sistema';
      }
      if (popStatus) {
        popStatus.replaceChildren();
        const mDot = document.createElement('span');
        mDot.className = 'mini-dot';
        mDot.style.background = '#EF4444';
        mDot.style.boxShadow = '0 0 6px #EF4444';
        popStatus.appendChild(mDot);
        popStatus.appendChild(document.createTextNode(' PÁGINA RESTRITA'));
        popStatus.style.color = '#EF4444';
      }
    } else if (tabStatus === 'loading') {
      pill.className = 'site-chip domain-pill warn';
      dot.className = 'status-dot dot-core-amber warn';
      if (ring) ring.className = 'ring-spin-amber';
      if (badge) {
        badge.className = 'security-badge warn';
        badge.textContent = 'Carregando...';
      }
      if (popStatus) {
        popStatus.replaceChildren();
        const mDot = document.createElement('span');
        mDot.className = 'mini-dot';
        mDot.style.background = '#F59E0B';
        mDot.style.boxShadow = '0 0 6px #F59E0B';
        popStatus.appendChild(mDot);
        popStatus.appendChild(document.createTextNode(' CARREGANDO RECURSOS'));
        popStatus.style.color = '#F59E0B';
      }
    } else if (url.startsWith('https://') || isLocalhostPage(url)) {
      pill.className = 'site-chip domain-pill';
      dot.className = 'status-dot dot-core-green ok';
      if (ring) ring.className = 'ring-pulse-green';
      if (badge) {
        badge.className = 'security-badge';
        badge.textContent = isLocalhostPage(url) ? 'Localhost' : 'HTTPS (Seguro)';
      }
      if (popStatus) {
        popStatus.replaceChildren();
        const mDot = document.createElement('span');
        mDot.className = 'mini-dot';
        mDot.style.background = '#3ECF8E';
        mDot.style.boxShadow = '0 0 6px #3ECF8E';
        popStatus.appendChild(mDot);
        popStatus.appendChild(document.createTextNode(' CONECTADO À ABA'));
        popStatus.style.color = '#3ECF8E';
      }
    } else if (url.startsWith('http://')) {
      pill.className = 'site-chip domain-pill warn';
      dot.className = 'status-dot dot-core-amber warn';
      if (ring) ring.className = 'ring-spin-amber';
      if (badge) {
        badge.className = 'security-badge warn';
        badge.textContent = 'HTTP (Não seguro)';
      }
      if (popStatus) {
        popStatus.replaceChildren();
        const mDot = document.createElement('span');
        mDot.className = 'mini-dot';
        mDot.style.background = '#F59E0B';
        mDot.style.boxShadow = '0 0 6px #F59E0B';
        popStatus.appendChild(mDot);
        popStatus.appendChild(document.createTextNode(' HTTP INSEGURO'));
        popStatus.style.color = '#F59E0B';
      }
    } else {
      pill.className = 'site-chip domain-pill muted';
      dot.className = 'status-dot dot-core-amber muted';
      if (ring) ring.className = 'ring-spin-amber';
      if (badge) {
        badge.className = 'security-badge muted';
        badge.textContent = 'Sistema';
      }
      if (popStatus) {
        popStatus.replaceChildren();
        const mDot = document.createElement('span');
        mDot.className = 'mini-dot';
        mDot.style.background = '#8A8F9E';
        mDot.style.boxShadow = '0 0 6px #8A8F9E';
        popStatus.appendChild(mDot);
        popStatus.appendChild(document.createTextNode(' PÁGINA INCOMPATÍVEL'));
        popStatus.style.color = '#8A8F9E';
      }
    }
  } catch {
    dText.textContent = isSystemBrowserPage(url) ? 'Sistema' : 'Incompatível';
    dot.className = 'status-dot dot-core-red muted';
    if (ring) ring.className = 'ring-static-red';
    if (badge) badge.textContent = isSystemBrowserPage(url) ? 'Sistema' : 'Incompatível';
  }
}

// --------------------------------------------------------------------------
// GERENCIADOR DE POPOVER DA ABA ATIVA (v11.1)
// --------------------------------------------------------------------------
let popoverPinned = false;
let popoverHoverTimer: any = null;

export function setupPopoverEvents() {
  const chip = document.getElementById('headerDomainPill');
  const popover = document.getElementById('site-popover');
  const btnSwitch = document.getElementById('btn-switch-tab');

  if (!chip || !popover) return;
  const chipEl = chip;
  const popoverEl = popover;

  function openPopover(pinned: boolean = false) {
    popoverEl.removeAttribute('hidden');
    chipEl.setAttribute('aria-expanded', 'true');
    if (pinned) popoverPinned = true;
  }

  function closePopover() {
    popoverEl.setAttribute('hidden', '');
    chipEl.setAttribute('aria-expanded', 'false');
    popoverPinned = false;
  }

  chipEl.onmouseenter = () => {
    if (popoverPinned) return;
    clearTimeout(popoverHoverTimer);
    popoverHoverTimer = setTimeout(() => {
      openPopover(false);
    }, 300);
  };

  chipEl.onmouseleave = () => {
    clearTimeout(popoverHoverTimer);
    if (!popoverPinned) {
      closePopover();
    }
  };

  chipEl.onclick = (e) => {
    e.stopPropagation();
    if (popoverEl.hasAttribute('hidden')) {
      openPopover(true);
    } else {
      closePopover();
    }
  };

  popoverEl.onclick = (e) => {
    e.stopPropagation();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      if (!chipEl.contains(e.target as Node) && !popoverEl.contains(e.target as Node)) {
        closePopover();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closePopover();
      }
    });
  }

  if (btnSwitch) {
    btnSwitch.onclick = async (e) => {
      e.stopPropagation();
      closePopover();
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        try {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const otherTabs = tabs.filter((t) => t.id && t.id !== currentTabId && (!t.url || !t.url.startsWith('chrome-extension://')));
          if (otherTabs.length > 0 && otherTabs[0].id) {
            await chrome.tabs.update(otherTabs[0].id, { active: true });
          }
        } catch {}
      }
    };
  }
}

// --------------------------------------------------------------------------
// MÁQUINA DE ESTADOS DA UI v4
// --------------------------------------------------------------------------
let lastAnnouncedMilestone = -1;

export function announceProgressMilestone(pct: number, customText?: string) {
  const milestoneEl = document.getElementById('downMilestoneAnnounce');
  if (!milestoneEl) return;

  if (pct === 0) {
    if (lastAnnouncedMilestone !== 0) {
      lastAnnouncedMilestone = 0;
      milestoneEl.textContent = customText || 'Iniciando captura';
    }
    return;
  }

  if (pct >= 100) {
    if (lastAnnouncedMilestone < 100) {
      lastAnnouncedMilestone = 100;
      milestoneEl.textContent = customText || 'Captura concluída';
    }
    return;
  }

  const milestones = [75, 50, 25];
  for (const m of milestones) {
    if (pct >= m) {
      if (lastAnnouncedMilestone < m) {
        lastAnnouncedMilestone = m;
        milestoneEl.textContent = `${m}% concluído`;
      }
      break;
    }
  }
}

export function setState(state: UiState, data?: any) {
  currentState = state;

  if (state === 'inicio') {
    skipAutoscrollRequested = false;
    requestSkipCurrentRequested = false;
    requestStopAndSaveRequested = false;
    isCapturePaused = false;
    isCaptureCancelled = false;
  }

  const states: UiState[] = [
    'inicio',
    'opcoes',
    'rolando',
    'analisando',
    'baixando',
    'pronto',
    'erro',
    'sem_acesso',
    'permissao',
    'login',
    'gravando',
    'gravacao_erro'
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
      const viewId = 'view-' + (s === 'sem_acesso' ? 'sem-acesso' : (s === 'gravacao_erro' ? 'gravacao-erro' : s));
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

  if (state === 'inicio') {
    const oTitle = document.getElementById('originTitle');
    const oHeroSub = document.getElementById('originHeroSub');
    if (oTitle) oTitle.textContent = 'Como deseja arquivar?';
    if (oHeroSub) oHeroSub.textContent = 'Escolha o modo de captura para salvar esta página.';
  }

  if (state === 'opcoes') {
    const sub = data?.subview || (currentMode === 'images' ? 'midias' : 'site');
    const subSite = document.getElementById('subview-opcoes-site');
    const subMidias = document.getElementById('subview-opcoes-midias');
    const subRolagem = document.getElementById('subview-opcoes-rolagem');
    const titleEl = document.getElementById('optionsViewTitle');
    const subEl = document.getElementById('optionsViewSub');
    const detBadge = document.getElementById('optionsDetectedBadge');
    if (subSite) subSite.style.display = sub === 'site' ? 'flex' : 'none';
    if (subMidias) subMidias.style.display = sub === 'midias' ? 'flex' : 'none';
    if (subRolagem) subRolagem.style.display = sub === 'rolagem' ? 'flex' : 'none';
    if (detBadge) detBadge.style.display = sub === 'rolagem' ? 'block' : 'none';
    if (titleEl) {
      titleEl.textContent = sub === 'site' ? 'Opções de Site inteiro' : (sub === 'midias' ? 'Filtros de Mídias' : 'Rolagem Infinita');
    }
    if (subEl) {
      subEl.textContent = sub === 'site'
        ? 'Defina os limites de navegação para varrer as páginas internas.'
        : (sub === 'midias' ? 'Escolha os tipos de arquivos e limites para o ZIP.' : 'Esta página carrega novos itens continuamente conforme você rola para baixo.');
    }
    const siteSubSw = document.getElementById('siteSubdomainsSwitch');
    if (siteSubSw) {
      siteSubSw.className = includeSubdomains ? 'switch-track' : 'switch-track off';
      siteSubSw.setAttribute('aria-checked', includeSubdomains ? 'true' : 'false');
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
    lastErrorData = data;
    if (pill) pill.className = 'site-chip domain-pill error';
    if (dot) dot.className = 'status-dot dot-core-red err';
    const ring = document.getElementById('domainRing');
    if (ring) ring.className = 'ring-static-red';
    const popStatus = document.getElementById('popover-status-text');
    if (popStatus) {
      popStatus.replaceChildren();
      const mDot = document.createElement('span');
      mDot.className = 'mini-dot';
      mDot.style.background = '#EF4444';
      mDot.style.boxShadow = '0 0 6px #EF4444';
      popStatus.appendChild(mDot);
      popStatus.appendChild(document.createTextNode(' PÁGINA RESTRITA'));
      popStatus.style.color = '#EF4444';
    }
    if (dText) {
      if (currentTabUrl) {
        dText.textContent = formatDisplayDomain(currentTabUrl);
      } else {
        dText.textContent = 'Sem página';
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
  } else if (state === 'gravando') {
    if (dot) dot.className = 'status-dot dot-core-red err';
    const ring = document.getElementById('domainRing');
    if (ring) ring.className = 'ring-pulse-red';
  } else if (state === 'gravacao_erro') {
    lastErrorData = data;
    if (pill) pill.className = 'site-chip danger';
    if (dot) dot.className = 'status-dot dot-core-red err';
    const ring = document.getElementById('domainRing');
    if (ring) ring.className = 'ring-pulse-red';
    if (dText) {
      const domainSource = lockedCaptureOrigin || lockedCaptureUrl || currentTabOrigin || currentTabUrl;
      dText.textContent = formatDisplayDomain(domainSource);
    }
  } else {
    const access = checkPageAccessibility(currentTabUrl, currentTabTitle);
    if (!access.accessible) {
      if (pill) pill.className = 'site-chip domain-pill error';
      if (dot) dot.className = 'status-dot dot-core-red err';
      const ring = document.getElementById('domainRing');
      if (ring) ring.className = 'ring-static-red';
      if (dText) dText.textContent = access.reason!;
      if (badge) {
        badge.className = 'security-badge muted';
        badge.textContent = access.reason!;
      }
    } else {
      const domainSource = (state === 'pronto' || state === 'baixando' || state === 'rolando' || state === 'analisando') && (lockedCaptureOrigin || lockedCaptureUrl)
        ? (lockedCaptureOrigin || lockedCaptureUrl)
        : (currentTabOrigin || currentTabUrl);
      const displayHost = formatDisplayDomain(domainSource);
      const hasValidHost = displayHost !== 'Sem página';

      if (pill) pill.className = 'site-chip';
      if (dot) dot.className = hasValidHost ? 'status-dot dot-core-green ok' : 'status-dot dot-core-red err';
      const ring = document.getElementById('domainRing');
      if (ring) ring.className = hasValidHost ? 'ring-pulse-green' : 'ring-static-red';

      if (dText) {
        dText.textContent = displayHost;
      }
    }
  }

  if (state === 'pronto' || state === 'erro' || state === 'inicio') {
    isCapturing = false;
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
      if (downFill) {
        downFill.style.width = pct + '%';
        downFill.classList.toggle('complete', pct >= 100);
      }
      const downProgressbar = document.getElementById('downProgressbar');
      if (downProgressbar) {
        downProgressbar.setAttribute('aria-valuenow', String(pct));
      }
      announceProgressMilestone(pct);
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
  } else if (state === 'pronto') {
    if (currentMode === 'html') {
      const pName = document.getElementById('prontoHtmlFilename');
      const pSuper = document.getElementById('prontoHtmlSuper');
      const pTitle = document.getElementById('prontoHtmlTitle');
      const pDesc = document.getElementById('prontoHtmlDesc');
      const pBadge = document.getElementById('prontoHtmlBadge');
      const pExpl = document.getElementById('prontoHtmlExpl');
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
      if (pSuper) pSuper.textContent = 'ARQUIVAMENTO CONCLUÍDO';
      if (pTitle) pTitle.textContent = 'Página arquivada!';
      if (pDesc) pDesc.textContent = 'O arquivo HTML foi gerado e está pronto para uso offline.';
      if (pBadge) pBadge.textContent = 'ARQUIVO ÚNICO';
      if (pExpl) pExpl.textContent = 'Abre com dois cliques em qualquer navegador. As imagens são carregadas do site original, então precisa de internet.';
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
      if (pTime) pTime.textContent = `${data?.elapsedTime || '0,0'} segundos`;

      const pHtmlWarn = document.getElementById('prontoHtmlWarning');
      if (pHtmlWarn) {
        const warningParts: string[] = [];
        if (data?.warnings?.mainStatus && data.warnings.mainStatus >= 400) {
          warningParts.push(`A página respondeu ${data.warnings.mainStatus}.`);
        }
        if (data?.warnings?.failedPages && data.warnings.totalPages) {
          warningParts.push(`${data.warnings.failedPages} de ${data.warnings.totalPages} páginas falharam.`);
        }
        if (data?.warnings?.networkLost) {
          warningParts.push('A conexão caiu durante a captura.');
        }
        if (warningParts.length > 0) {
          pHtmlWarn.textContent = warningParts.join(' ');
          pHtmlWarn.style.display = 'block';
        } else {
          pHtmlWarn.style.display = 'none';
        }
      }
    } else {
      const pName = document.getElementById('prontoZipFilename');
      const pSuper = document.getElementById('prontoZipSuper');
      const pTitle = document.getElementById('prontoZipTitle');
      const pDesc = document.getElementById('prontoZipDesc');
      const pBadge = document.getElementById('prontoZipBadge');
      const pExpl = document.getElementById('prontoZipExpl');
      const pMeta = document.getElementById('prontoZipMeta');
      const pPages = document.getElementById('prontoZipPages');
      const pCss = document.getElementById('prontoZipCss');
      const pFonts = document.getElementById('prontoZipFonts');
      const pImgs = document.getElementById('prontoZipImages');
      const pCors = document.getElementById('prontoZipCors');
      const pTimeout = document.getElementById('prontoZipTimeout');
      const pTime = document.getElementById('prontoZipTime');

      if (pName) pName.textContent = data?.filename || (currentMode === 'images' ? 'midias.zip' : 'site.zip');

      if (currentMode === 'images') {
        if (pSuper) pSuper.textContent = 'EXTRAÇÃO CONCLUÍDA';
        if (pTitle) pTitle.textContent = 'Mídias extraídas!';
        if (pDesc) pDesc.textContent = 'O arquivo ZIP com as mídias está pronto para download.';
        if (pBadge) pBadge.textContent = 'MÍDIAS';
        if (pExpl) pExpl.textContent = 'Abra o ZIP para ver os arquivos organizados em pastas (imagens, vetores, vídeos e áudios).';
      } else if (currentScope === 'site_inteiro' || currentScope === 'paginas_vinculadas') {
        if (pSuper) pSuper.textContent = 'ARQUIVAMENTO CONCLUÍDO';
        if (pTitle) pTitle.textContent = 'Site arquivado!';
        if (pDesc) pDesc.textContent = 'O arquivo ZIP do site está pronto para navegação offline.';
        if (pBadge) pBadge.textContent = 'CÓPIA FIEL';
        if (pExpl) pExpl.textContent = 'Descompacte o ZIP e abra index.html em qualquer navegador para navegar pelo site.';
      } else {
        if (pSuper) pSuper.textContent = 'ARQUIVAMENTO CONCLUÍDO';
        if (pTitle) pTitle.textContent = 'Página arquivada!';
        if (pDesc) pDesc.textContent = 'O arquivo ZIP foi gerado e está pronto para uso offline.';
        if (pBadge) pBadge.textContent = 'CÓPIA FIEL';
        if (pExpl) pExpl.textContent = 'Abre com dois cliques em qualquer navegador sem precisar de internet ou programas especiais.';
      }

      if (pMeta) {
        if (data?.sizeText) {
          pMeta.textContent = `Tamanho do arquivo: ${data.sizeText}`;
          pMeta.style.display = 'block';
        } else {
          pMeta.style.display = 'none';
        }
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
      if (pTime) pTime.textContent = `${data?.elapsedTime || '0,0'} segundos decorridos`;

      const pZipWarn = document.getElementById('prontoZipWarning');
      if (pZipWarn) {
        const warningParts: string[] = [];
        if (data?.warnings?.mainStatus && data.warnings.mainStatus >= 400) {
          warningParts.push(`A página respondeu ${data.warnings.mainStatus}.`);
        }
        if (data?.warnings?.failedPages && data.warnings.totalPages) {
          warningParts.push(`${data.warnings.failedPages} de ${data.warnings.totalPages} páginas falharam.`);
        }
        if (data?.warnings?.networkLost) {
          warningParts.push('A conexão caiu durante a captura.');
        }
        if (warningParts.length > 0) {
          pZipWarn.textContent = warningParts.join(' ');
          pZipWarn.style.display = 'block';
        } else {
          pZipWarn.style.display = 'none';
        }
      }
    }
  } else if (state === 'permissao') {
    const pDom = document.getElementById('permDomain');
    const pScope = document.getElementById('permScopeText');
    let safeHost = 'este domínio';
    try {
      if (currentTabOrigin) safeHost = new URL(currentTabOrigin).hostname;
    } catch {}
    if (pDom) pDom.textContent = safeHost;
    if (pScope) pScope.textContent = `Rotas sob ${safeHost}`;
  } else if (state === 'erro') {
    const errTitle = document.getElementById('erroTitle');
    const errSub = document.getElementById('erroSub');
    const errProto = document.getElementById('erroProtocol');
    if (errTitle) errTitle.textContent = data?.errorTitle || 'Página de sistema incompatível';
    if (errSub) errSub.textContent = data?.errorDetail || 'Navegadores bloqueiam extensões em abas internas';
    if (errProto) {
      if (data?.errorDetail && (data.isDebuggerDetached || data.isEmptyMedia)) {
        errProto.textContent = data.errorDetail;
      } else if (data?.url) {
        errProto.textContent = `URL: ${data.url}`;
      } else {
        errProto.textContent = 'Selecione uma aba com página web comum (HTTP, HTTPS, file://)';
      }
    }
  } else if (state === 'gravando') {
    const gTitle = document.getElementById('gravandoTitle');
    const gUrl = document.getElementById('gravandoUrl');
    const gTimer = document.getElementById('gravandoTimer');
    if (gTitle) gTitle.textContent = currentTabTitle || 'Gravando página ativa';
    if (gUrl) gUrl.textContent = currentTabUrl || 'https://...';

    recordingStartTime = Date.now();
    if (recordingTimerInterval) clearInterval(recordingTimerInterval);
    recordingTimerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - (recordingStartTime || Date.now())) / 1000);
      const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const secs = String(elapsedSec % 60).padStart(2, '0');
      if (gTimer) gTimer.textContent = `${mins}:${secs}`;
    }, 500);
  } else if (state === 'gravacao_erro') {
    if (recordingTimerInterval) {
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }

    const titleEl = document.getElementById('gravacaoErroTitle');
    const superEl = document.getElementById('gravacaoErroSuper');
    const msgEl = document.getElementById('gravacaoErroMsg');
    const subEl = document.getElementById('gravacaoErroSub');
    const presBox = document.getElementById('gravacaoErroPreservadaBox');
    const presEl = document.getElementById('gravacaoErroPreservada');
    const presLbl = document.getElementById('gravacaoErroPreservadaLabel');

    const isInterrupted = Boolean(data?.isInterrupted);
    const reason = data?.reason;

    if (isInterrupted) {
      if (reason === 'tab_closed') {
        if (superEl) superEl.textContent = 'ABA FECHADA';
        if (titleEl) titleEl.textContent = 'A aba foi fechada';
        if (msgEl) msgEl.textContent = 'A aba foi fechada durante a captura.';
      } else {
        if (superEl) superEl.textContent = 'SITE ALTERADO';
        if (titleEl) titleEl.textContent = 'A aba foi para outro site';
        if (msgEl) msgEl.textContent = 'A aba foi para outro site durante a captura.';
      }
      if (subEl) {
        subEl.textContent = 'Escolha se deseja salvar o que já capturou antes de sair ou recomeçar.';
      }
      if (presLbl) {
        presLbl.textContent = 'Captura preservada:';
      }
    } else {
      let origHost = 'página';
      try {
        const u = lockedCaptureOrigin || currentTabOrigin;
        if (u) origHost = new URL(u).hostname;
      } catch {}
      if (superEl) superEl.textContent = 'PÁGINA ALTERADA';
      if (titleEl) titleEl.textContent = 'Você saiu da página';
      if (msgEl) {
        msgEl.textContent = data?.errorMsg || `A gravação vale só para a página onde começou. Você saiu de ${origHost} para outro endereço.`;
      }
      if (subEl) {
        subEl.textContent = 'Escolha se deseja salvar o que já gravou antes de sair ou recomeçar a gravação na página original.';
      }
      if (presLbl) {
        presLbl.textContent = 'Gravação preservada:';
      }
    }

    if (presEl && data?.retainedText) {
      presEl.textContent = data.retainedText;
      if (presBox) presBox.style.display = 'block';
    } else if (presBox) {
      presBox.style.display = 'none';
    }
  }
}

// --------------------------------------------------------------------------
// SVGs TABLER (MIT) EMBUTIDOS PARA A INTERFACE v11 / v12
// --------------------------------------------------------------------------
export function createTablerSparkles(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tabler-icon');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p1.setAttribute('stroke', 'none');
  p1.setAttribute('d', 'M0 0h24v24H0z');
  p1.setAttribute('fill', 'none');

  const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p2.setAttribute('d', 'M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z');

  svg.appendChild(p1);
  svg.appendChild(p2);
  return svg;
}

function createTablerArrowRight(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tabler-icon');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p1.setAttribute('stroke', 'none');
  p1.setAttribute('d', 'M0 0h24v24H0z');
  p1.setAttribute('fill', 'none');

  const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p2.setAttribute('d', 'M5 12l14 0');

  const p3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p3.setAttribute('d', 'M13 18l6 -6');

  const p4 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p4.setAttribute('d', 'M13 6l6 6');

  svg.appendChild(p1);
  svg.appendChild(p2);
  svg.appendChild(p3);
  svg.appendChild(p4);
  return svg;
}

function createTablerArrowLeft(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tabler-icon');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M5 12l14 0 M5 12l6 6 M5 12l6 -6');
  svg.appendChild(p);
  return svg;
}

function createTablerDownload(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tabler-icon');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2 M7 11l5 5l5 -5 M12 4l0 12');
  svg.appendChild(p);
  return svg;
}

function createTablerRotate(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tabler-icon');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5');
  svg.appendChild(p);
  return svg;
}

function createTablerSquare(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tabler-icon');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M5 5m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z');
  svg.appendChild(p);
  return svg;
}

function createTablerPlayerSkipForward(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tabler-icon');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p1.setAttribute('d', 'M4 5v14l10 -7z');
  const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p2.setAttribute('d', 'M20 5l0 14');
  svg.appendChild(p1);
  svg.appendChild(p2);
  return svg;
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

    const access = checkPageAccessibility(currentTabUrl, currentTabTitle);
    if (!access.accessible) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('disabled');
    }

    btn.appendChild(createTablerSparkles());

    const triggerStart = (fn: () => void | Promise<void>) => {
      if (!access.accessible || isCapturing || btn.disabled) return;
      isCapturing = true;
      btn.disabled = true;
      btn.classList.add('disabled');
      fn();
    };

    const label = document.createElement('span');
    if (captureMethod === 'recording') {
      label.textContent = 'Iniciar gravação manual';
      btn.onclick = () => triggerStart(() => handleStartRecording());
    } else if (currentMode === 'html') {
      label.textContent = 'Baixar HTML Autossuficiente';
      btn.onclick = () => triggerStart(() => handlePrimaryStart());
    } else if (currentMode === 'images') {
      label.textContent = 'Baixar Galeria de Mídias';
      btn.onclick = () => triggerStart(() => handlePrimaryStart());
    } else {
      label.textContent = 'Começar a arquivar';
      btn.onclick = () => triggerStart(() => handlePrimaryStart());
    }

    btn.appendChild(label);
    btn.appendChild(createTablerArrowRight());
    footer.appendChild(btn);

    if (!access.accessible && access.reason) {
      const reasonEl = document.createElement('div');
      reasonEl.className = 'main-action-disabled-reason';
      reasonEl.id = 'mainActionDisabledReason';
      reasonEl.textContent = access.reason;
      footer.appendChild(reasonEl);
    }
  } else if (currentState === 'rolando' || currentState === 'analisando' || currentState === 'baixando') {
    const btnContainer = document.createElement('div');
    btnContainer.style.display = 'flex';
    btnContainer.style.flexDirection = 'column';
    btnContainer.style.gap = '8px';
    btnContainer.style.width = '100%';

    // 1. Botão "Parar e salvar o que já baixou" (com badge GERAR ZIP)
    const btnStopSave = document.createElement('button');
    btnStopSave.type = 'button';
    btnStopSave.className = 'btn-primary';
    btnStopSave.id = 'btnStopAndSave';
    btnStopSave.style.background = '#FFFFFF';
    btnStopSave.style.color = '#0B0B0C';
    btnStopSave.style.display = 'flex';
    btnStopSave.style.justifyContent = 'space-between';
    btnStopSave.style.alignItems = 'center';

    const stopLeft = document.createElement('div');
    stopLeft.style.display = 'flex';
    stopLeft.style.alignItems = 'center';
    stopLeft.style.gap = '8px';
    stopLeft.appendChild(createTablerSquare());
    const stopTxt = document.createElement('span');
    stopTxt.textContent = 'Parar e salvar o que já baixou';
    stopLeft.appendChild(stopTxt);
    btnStopSave.appendChild(stopLeft);

    const stopBadge = document.createElement('span');
    stopBadge.className = 'type-special';
    stopBadge.style.border = '1px solid #0B0B0C';
    stopBadge.style.padding = '2px 5px';
    stopBadge.style.borderRadius = '2px';
    stopBadge.textContent = currentMode === 'html' ? 'GERAR HTML' : 'GERAR ZIP';
    btnStopSave.appendChild(stopBadge);

    btnStopSave.onclick = () => {
      requestStopAndSaveRequested = true;
      skipAutoscrollRequested = true;
    };

    // 2. Botão "Pular"
    const btnSkip = document.createElement('button');
    btnSkip.type = 'button';
    btnSkip.className = 'btn-secondary';
    btnSkip.id = currentState === 'rolando' ? 'btnSkipScroll' : 'btnSkipCurrent';
    btnSkip.style.display = 'flex';
    btnSkip.style.alignItems = 'center';
    btnSkip.style.justifyContent = 'center';
    btnSkip.style.gap = '8px';

    btnSkip.appendChild(createTablerPlayerSkipForward());

    const skipTxt = document.createElement('span');
    if (currentState === 'rolando') {
      skipTxt.textContent = 'Pular rolagem';
    } else if (currentMode === 'images') {
      skipTxt.textContent = 'Pular esta mídia';
    } else {
      skipTxt.textContent = 'Pular esta página';
    }
    btnSkip.appendChild(skipTxt);

    btnSkip.onclick = () => {
      if (currentState === 'rolando') {
        skipAutoscrollRequested = true;
      } else {
        requestSkipCurrentRequested = true;
      }
    };

    btnContainer.appendChild(btnStopSave);
    btnContainer.appendChild(btnSkip);

    footer.appendChild(btnContainer);
  } else if (currentState === 'pronto') {
    const btnOpen = document.createElement('button');
    btnOpen.type = 'button';
    btnOpen.className = 'btn-primary';
    btnOpen.id = 'btnOpenResult';
    btnOpen.style.display = 'none';
    btnOpen.textContent = currentMode === 'html' ? 'Abrir Arquivo HTML' : 'Abrir Arquivo ZIP';

    const btnAgain = document.createElement('button');
    btnAgain.type = 'button';
    btnAgain.className = 'btn-primary';
    btnAgain.id = 'btnDownloadAgain';

    const againInner = document.createElement('div');
    againInner.style.display = 'flex';
    againInner.style.alignItems = 'center';
    againInner.style.gap = '8px';
    againInner.appendChild(createTablerDownload());
    const againTxt = document.createElement('span');
    againTxt.textContent = 'Baixar novamente';
    againInner.appendChild(againTxt);

    btnAgain.appendChild(againInner);
    btnAgain.appendChild(createTablerArrowRight());
    btnAgain.onclick = () => {
      downloadAgain();
    };

    const btnBack = document.createElement('button');
    btnBack.type = 'button';
    btnBack.className = 'btn-secondary btn-small';
    btnBack.id = 'btnBackToStart';
    btnBack.setAttribute('aria-label', 'Voltar ao início (descarta o arquivo)');
    btnBack.appendChild(createTablerArrowLeft());
    const backTxt = document.createElement('span');
    backTxt.textContent = 'Voltar ao início (descarta o arquivo)';
    btnBack.appendChild(backTxt);
    btnBack.onclick = () => {
      resetToInitialState();
    };

    footer.appendChild(btnOpen);
    footer.appendChild(btnAgain);
    footer.appendChild(btnBack);
  } else if (currentState === 'gravando') {
    const btnStop = document.createElement('button');
    btnStop.type = 'button';
    btnStop.className = 'btn-primary';
    btnStop.id = 'btnStopRecording';
    btnStop.textContent = 'Parar e Salvar';
    btnStop.onclick = () => {
      handleStopRecording();
    };

    footer.appendChild(btnStop);
  } else if (currentState === 'gravacao_erro') {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '8px';
    wrap.style.width = '100%';

    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'btn-primary';
    btnSave.id = 'btnSaveRecorded';

    const saveInner = document.createElement('div');
    saveInner.style.display = 'flex';
    saveInner.style.alignItems = 'center';
    saveInner.style.gap = '8px';
    saveInner.appendChild(createTablerDownload());
    const saveTxt = document.createElement('span');
    saveTxt.textContent = lastErrorData?.isInterrupted ? 'Salvar o que já capturei' : 'Salvar o que já gravei';
    saveInner.appendChild(saveTxt);

    btnSave.appendChild(saveInner);
    btnSave.appendChild(createTablerArrowRight());
    btnSave.onclick = async () => {
      if (lastErrorData?.partialBlob && lastErrorData?.partialFilename) {
        await triggerBrowserDownload(lastErrorData.partialBlob, lastErrorData.partialFilename);
        setState('pronto', {
          filename: lastErrorData.partialFilename,
          sizeText: formatBytes(lastErrorData.partialBlob.size),
          pages: 1,
          totalAssets: 0,
          elapsedTime: '00:00'
        });
      } else {
        handleSaveRecorded();
      }
    };

    const btnRestart = document.createElement('button');
    btnRestart.type = 'button';
    btnRestart.className = 'btn-secondary';
    btnRestart.id = 'btnRestartRecording';
    btnRestart.appendChild(createTablerRotate());
    const restartTxt = document.createElement('span');
    restartTxt.textContent = lastErrorData?.isInterrupted ? 'Recomeçar' : 'Recomeçar na página original';
    btnRestart.appendChild(restartTxt);
    btnRestart.onclick = () => {
      handleRestartRecording();
    };

    wrap.appendChild(btnSave);
    wrap.appendChild(btnRestart);
    footer.appendChild(wrap);
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
    if (lastErrorData?.isEmptyMedia) {
      const btnBack = document.createElement('button');
      btnBack.type = 'button';
      btnBack.className = 'btn-secondary';
      btnBack.id = 'btnBackToStart';
      btnBack.textContent = 'Voltar';
      btnBack.setAttribute('aria-label', 'Voltar');
      btnBack.onclick = () => {
        resetToInitialState();
      };
      footer.appendChild(btnBack);
      return;
    }

    if (lastErrorData?.isDebuggerDetached) {
      const btnRetry = document.createElement('button');
      btnRetry.type = 'button';
      btnRetry.className = 'btn-primary';
      btnRetry.id = 'btnRetryCapture';
      btnRetry.textContent = 'Tentar de novo';
      btnRetry.onclick = () => {
        handlePrimaryStart();
      };

      const btnBack = document.createElement('button');
      btnBack.type = 'button';
      btnBack.className = 'btn-secondary';
      btnBack.id = 'btnBackToStart';
      btnBack.textContent = 'Voltar';
      btnBack.setAttribute('aria-label', 'Voltar');
      btnBack.onclick = () => {
        resetToInitialState();
      };

      footer.appendChild(btnRetry);
      footer.appendChild(btnBack);
      return;
    }

    const btnDis = document.createElement('button');
    btnDis.type = 'button';
    btnDis.className = 'btn-disabled';
    btnDis.id = 'btnMainAction';
    btnDis.disabled = true;
    btnDis.textContent = 'Aguardando aba compatível';

    const btnBack = document.createElement('button');
    btnBack.type = 'button';
    btnBack.className = 'btn-secondary btn-small';
    btnBack.id = 'btnBackToStart';
    btnBack.textContent = 'Voltar ao início';
    btnBack.setAttribute('aria-label', 'Voltar ao início');
    btnBack.onclick = () => {
      resetToInitialState();
    };

    note.textContent = 'Mude de aba ou volte ao início para tentar novamente';
    footer.appendChild(btnDis);
    footer.appendChild(btnBack);
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
      const siteSubSw = document.getElementById('siteSubdomainsSwitch');
      if (siteSubSw) {
        siteSubSw.className = 'switch-track off';
        siteSubSw.setAttribute('aria-checked', 'false');
      }
    } else {
      limitPages = 100;
      limitMb = 200;
      includeSubdomains = false;
      renderChips('pags', [50, 100, 250], 100);
      renderChips('mb', [100, 200, 500], 200);
      if (subSwitch) subSwitch.className = 'switch-track off';
      const siteSubSw = document.getElementById('siteSubdomainsSwitch');
      if (siteSubSw) {
        siteSubSw.className = 'switch-track off';
        siteSubSw.setAttribute('aria-checked', 'false');
      }
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
      if (isActionKey(e)) {
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

export function selectMode(mode: UiMode | 'piece' | 'site') {
  if (mode === 'piece') {
    currentMode = 'zip';
    setScope('esta_pagina');
  } else if (mode === 'site') {
    currentMode = 'zip';
    setScope('site_inteiro');
  } else if (mode === 'images') {
    currentMode = 'images';
    setScope('esta_pagina');
  } else {
    currentMode = mode;
    setScope('esta_pagina');
  }

  const mZip = document.getElementById('mode-zip');
  const mPiece = document.getElementById('mode-piece');
  const mHtml = document.getElementById('mode-html');
  const mImgs = document.getElementById('mode-images');
  const mSite = document.getElementById('mode-site');

  if (mZip) {
    const isSel = mode === 'zip';
    mZip.className = `card interactive mode-card ${isSel ? 'selected' : ''}`;
    mZip.setAttribute('aria-checked', isSel ? 'true' : 'false');
    mZip.tabIndex = isSel ? 0 : -1;
  }
  if (mPiece) {
    const isSel = mode === 'piece';
    mPiece.className = `card interactive mode-card ${isSel ? 'selected' : ''}`;
    mPiece.setAttribute('aria-checked', isSel ? 'true' : 'false');
    mPiece.tabIndex = isSel ? 0 : -1;
  }
  if (mHtml) {
    const isSel = mode === 'html';
    mHtml.className = `card interactive mode-card ${isSel ? 'selected' : ''}`;
    mHtml.setAttribute('aria-checked', isSel ? 'true' : 'false');
    mHtml.tabIndex = isSel ? 0 : -1;
  }
  if (mImgs) {
    const isSel = mode === 'images';
    mImgs.className = `card interactive mode-card ${isSel ? 'selected' : ''}`;
    mImgs.setAttribute('aria-checked', isSel ? 'true' : 'false');
    mImgs.tabIndex = isSel ? 0 : -1;
  }
  if (mSite) {
    const isSel = mode === 'site';
    mSite.className = `card interactive mode-card ${isSel ? 'selected' : ''}`;
    mSite.setAttribute('aria-checked', isSel ? 'true' : 'false');
    mSite.tabIndex = isSel ? 0 : -1;
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
  const access = checkPageAccessibility(currentTabUrl, currentTabTitle);
  if (!access.accessible) {
    isCapturing = false;
    return;
  }

  if (!currentTabUrl || !validateUrl(currentTabUrl, true).valid) {
    isCapturing = false;
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
  // O tempo de rolagem escolhido conta a partir do clique (inclui reload do CDP), como o usuário cronometra
  const flowStartedAt = Date.now();
  skipAutoscrollRequested = false;
  requestSkipCurrentRequested = false;
  requestStopAndSaveRequested = false;
  isCapturePaused = false;
  isCaptureCancelled = false;

  const lockedTabId = currentTabId;
  const lockedTabUrl = currentTabUrl;
  const lockedTabTitle = currentTabTitle;
  const lockedTabOrigin = currentTabOrigin;

  lockedCaptureTabId = lockedTabId;
  lockedCaptureUrl = lockedTabUrl;
  lockedCaptureOrigin = lockedTabOrigin;
  lockedCaptureTitle = lockedTabTitle;

  const tabGuard = (lockedTabId && lockedTabUrl) ? watchTargetTab(lockedTabId, lockedTabUrl) : undefined;
  let interruptedHandled = false;
  const triggerInterruption = (reason: 'tab_closed' | 'navigated_away') => {
    isCaptureCancelled = true;
    if (interruptedHandled) return;
    interruptedHandled = true;
    const errorMsg = reason === 'tab_closed'
      ? 'A aba foi fechada durante a captura.'
      : 'A aba foi para outro site durante a captura.';
    const filename = getLockedCaptureZipFilename();
    setState('gravacao_erro', {
      errorMsg,
      retainedText: '0 RECURSOS SALVOS',
      partialFilename: filename,
      isInterrupted: true,
      reason
    });
  };

  tabGuard?.onInterrupted((reason) => {
    triggerInterruption(reason);
  });

  let activeRecorder: CdpNetworkRecorder | null = null;
  if (currentMode === 'zip' && lockedTabId && typeof chrome !== 'undefined' && chrome.debugger) {
    try {
      activeRecorder = new CdpNetworkRecorder(lockedTabId);
      activeRecorder.onDetached(() => {
        isCaptureCancelled = true;
      });
      await activeRecorder.start();

      // Recarrega a aba sob o depurador CDP para registrar 100% dos recursos iniciais (WASM, 3D, Shaders, Webfonts)
      if (chrome.tabs && typeof chrome.tabs.reload === 'function') {
        await new Promise<void>((resolve) => {
          chrome.tabs.reload(lockedTabId!, { bypassCache: true }, () => resolve());
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
  if (lockedTabId && typeof chrome !== 'undefined' && chrome.scripting && !tabGuard?.reason) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: lockedTabId },
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

  if (tabGuard?.reason) {
    triggerInterruption(tabGuard.reason);
    if (activeRecorder) await activeRecorder.stop().catch(() => {});
    if (tabGuard) tabGuard.stop();
    return;
  }

  // 1. Fase de Rolagem (se habilitada)
  if (autoscrollOn && lockedTabId && !tabGuard?.reason && !isCaptureCancelled) {
    setState('rolando', { currentY: 0, maxY: 1000, step: 0, imagesCount: 0 });
    await runRealAutoscrollInTab(lockedTabId, getActiveAutoscrollOptions(), flowStartedAt, tabGuard);
    if (tabGuard?.reason) {
      triggerInterruption(tabGuard.reason);
      if (activeRecorder) await activeRecorder.stop().catch(() => {});
      if (tabGuard) tabGuard.stop();
      return;
    }
    if (isCaptureCancelled) {
      if (activeRecorder) await activeRecorder.stop().catch(() => {});
      if (tabGuard) tabGuard.stop();
      return;
    }
  }

  if (tabGuard?.reason) {
    triggerInterruption(tabGuard.reason);
    if (activeRecorder) await activeRecorder.stop().catch(() => {});
    if (tabGuard) tabGuard.stop();
    return;
  }

  // 2. Fase de Captura e Download
  if (currentScope !== 'esta_pagina' && !tabGuard?.reason && !isCaptureCancelled) {
    setState('analisando', { pages: 1, resources: 12 });
    await new Promise((r) => setTimeout(r, 600));
  }

  if (tabGuard?.reason) {
    triggerInterruption(tabGuard.reason);
    if (activeRecorder) await activeRecorder.stop().catch(() => {});
    if (tabGuard) tabGuard.stop();
    return;
  }

  await performRealCapture(activeRecorder, initialCleanHtml, tabGuard, lockedTabId, lockedTabUrl, lockedTabTitle);
}

// Execução de autoscroll no DOM da aba ativa com métricas reais
async function runRealAutoscrollInTab(
  tabId: number,
  customOpts?: AutoscrollOptions,
  startTime: number = Date.now(),
  tabGuard?: TabGuard
): Promise<void> {
  const opts = customOpts || getActiveAutoscrollOptions();
  const step = opts.step || 400;
  const intervalMs = opts.intervalMs || 150;
  let stepIndex = 0;

  const limitType = opts.limitType || 'screens';
  const maxScreens = opts.maxScreens !== undefined ? opts.maxScreens : 10;
  const maxTimeSeconds = opts.maxTimeSeconds !== undefined ? opts.maxTimeSeconds : (limitType === 'time' ? 30 : 60);
  const maxDurationMs =
    limitType === 'time'
      ? maxTimeSeconds * 1000
      : (limitType === 'unlimited' ? 3600000 : maxTimeSeconds * 1000);
  const maxHeight = limitType === 'unlimited' ? 1000000 : 60000;
  // Volta ao topo + estabilização do Hero cabe dentro do tempo pedido
  const settleMs = 1500;
  const scrollBudgetMs = limitType === 'time' ? Math.max(0, maxDurationMs - settleMs) : maxDurationMs;
  const viewportHeight = 800;

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

    while (
      (limitType === 'time' || currentY < docHeight) &&
      (limitType === 'time' || currentY < maxHeight)
    ) {
      if (
        skipAutoscrollRequested ||
        requestSkipCurrentRequested ||
        requestStopAndSaveRequested ||
        isCaptureCancelled ||
        tabGuard?.reason
      ) {
        requestSkipCurrentRequested = false;
        break;
      }

      if (Date.now() - startTime >= scrollBudgetMs) {
        break;
      }

      const currentScreens = Math.floor(currentY / viewportHeight);
      if (limitType === 'screens' && currentScreens >= maxScreens) {
        break;
      }

      if (currentY < docHeight) {
        currentY = Math.min(docHeight, currentY + step);
      }
      stepIndex++;

      try {
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
            const scrollEl = document.scrollingElement || h || b;
            if (scrollEl && typeof (scrollEl as any).scrollTop === 'number') {
              try { (scrollEl as any).scrollTop = targetY; } catch {}
            }

            const totalH = Math.max(
              b ? b.scrollHeight : 0,
              b ? b.offsetHeight : 0,
              h ? h.clientHeight : 0,
              h ? h.scrollHeight : 0,
              h ? h.offsetHeight : 0,
              scrollEl ? scrollEl.scrollHeight : 0
            );

            return {
              totalH,
              actualY: Math.round(window.scrollY || (scrollEl ? scrollEl.scrollTop : 0)),
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
      } catch (stepErr) {
        // Ignora erro passageiro durante frames ocupados para não interromper a rolagem
      }

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
    await new Promise((r) => setTimeout(r, settleMs));
  } catch (err) {
    console.warn('Erro ao executar autoscroll na aba:', err);
  }
}

// Execução real da captura com os motores correspondentes
async function performRealCapture(
  existingRecorder?: CdpNetworkRecorder | null,
  initialCleanHtml?: string,
  tabGuard?: TabGuard,
  targetTabId?: number | null,
  targetTabUrl?: string,
  targetTabTitle?: string
): Promise<void> {
  const tabId = targetTabId !== undefined ? targetTabId : (lockedCaptureTabId || currentTabId);
  const url = targetTabUrl !== undefined ? targetTabUrl : (lockedCaptureUrl || currentTabUrl);
  const title = targetTabTitle !== undefined ? targetTabTitle : (lockedCaptureTitle || currentTabTitle);

  const guard = tabGuard || (tabId && url ? watchTargetTab(tabId, url) : undefined);

  if (guard?.reason) {
    const reason = guard.reason;
    const errorMsg = reason === 'tab_closed'
      ? 'A aba foi fechada durante a captura.'
      : 'A aba foi para outro site durante a captura.';
    setState('gravacao_erro', {
      errorMsg,
      retainedText: '0 RECURSOS SALVOS',
      partialFilename: getLockedCaptureZipFilename(),
      isInterrupted: true,
      reason
    });
    return;
  }

  guard?.onInterrupted((reason) => {
    isCaptureCancelled = true;
    if (currentState !== 'gravacao_erro') {
      const errorMsg = reason === 'tab_closed'
        ? 'A aba foi fechada durante a captura.'
        : 'A aba foi para outro site durante a captura.';
      setState('gravacao_erro', {
        errorMsg,
        retainedText: '0 RECURSOS SALVOS',
        partialFilename: getLockedCaptureZipFilename(),
        isInterrupted: true,
        reason
      });
    }
  });

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
    nextItem: title,
    nextDesc: 'Gravando nós do DOM e dependências'
  });

  try {
    // 1. Obtenção do HTML bruto diretamente da aba ativa
    let pageRawHtml = targetTabOverrideHtml || '';
    if (!pageRawHtml && typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      // Se for modo HTML e houver canvas WebGL, obtém snapshot CDP com clip
      const canvasSnapshots: Array<{ index: number; dataUrl: string }> = [];
      if (currentMode === 'html' && typeof chrome !== 'undefined' && chrome.debugger) {
        try {
          const [{ result: rects }] = await chrome.scripting.executeScript({
            target: { tabId },
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
              await chrome.debugger.attach({ tabId }, '1.3');
              for (const c of rects.slice(0, 3)) {
                try {
                  const shotRes: any = await chrome.debugger.sendCommand(
                    { tabId },
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
              await chrome.debugger.detach({ tabId }).catch(() => {});
            }
          }
        } catch (e) {
          console.warn('Snapshot CDP de canvas ignorado:', e);
        }
      }

      try {
        const [{ result: pageData }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (mode: string, snapshots: Array<{ index: number; dataUrl: string }>, serializeFnCode: string) => {
            const getDomHtml = () => {
              try {
                const fn = new Function('return (' + serializeFnCode + ')()');
                const s = fn();
                if (s && s.length > 50) return s;
              } catch {}
              return document.documentElement.outerHTML;
            };

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

                const html = getDomHtml();
                const title = document.title || 'Página';

                // Restaura o DOM original na aba ativa para não interferir na renderização viva
                createdImgs.forEach((img) => img.remove());
                canvases.forEach((cv) => { cv.style.display = ''; });

                return { html, title };
              } catch {}
            }

            return {
              html: getDomHtml(),
              title: document.title || 'Página'
            };
          },
          args: [currentMode, canvasSnapshots, serializeLiveDom.toString()]
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
        const cdpHtml = await existingRecorder.evaluate(`(${serializeLiveDom.toString()})()`);
        if (cdpHtml) pageRawHtml = cdpHtml;
      } catch (cdpErr) {
        console.warn('CDP recorder evaluate falhou:', cdpErr);
      }
    } else if (!pageRawHtml && typeof chrome !== 'undefined' && chrome.debugger && tabId) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        const evalRes: any = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(${serializeLiveDom.toString()})()`,
          returnByValue: true
        });
        if (evalRes?.result?.value) {
          pageRawHtml = evalRes.result.value;
        }
        await chrome.debugger.detach({ tabId });
      } catch (cdpErr) {
        console.warn('CDP evaluate fallback falhou:', cdpErr);
      }
    }

    // Se for modo ZIP (Página Completa Fiel), prioriza o HTML inicial limpo para preservar
    // hidratação limpa do React, Lenis funcionando desde o scroll 0 e parallax idêntico ao vivo,
    // DESDE QUE não seja um esqueleto não-hidratado (ex: YouTube, SPAs com skeleton)
    if (
      currentMode === 'zip' &&
      initialCleanHtml &&
      isValidDocumentHtml(initialCleanHtml) &&
      !isSpaSkeleton(initialCleanHtml)
    ) {
      pageRawHtml = initialCleanHtml;
    }

    // Validação estrita: se o HTML estiver vazio, ERRA claramente e NÃO salva arquivo vazio
    if (!isValidDocumentHtml(pageRawHtml)) {
      throw new Error(`O documento HTML da página ativa está vazio ou inacessível (${currentTabUrl || 'sem URL'}).`);
    }

    // 2. Executa o módulo de acordo com o modo e escopo
    if (currentMode === 'html') {
      let res: any = null;
      res = await pageHtmlModule.run({
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

    if (currentMode === 'images') {
      const selectedTypes: MediaType[] = [];
      const chkImg = document.getElementById('mediaCheckImg') as HTMLInputElement | null;
      const chkSvg = document.getElementById('mediaCheckSvg') as HTMLInputElement | null;
      const chkVid = document.getElementById('mediaCheckVid') as HTMLInputElement | null;
      const chkAud = document.getElementById('mediaCheckAud') as HTMLInputElement | null;

      if (!chkImg || chkImg.checked) selectedTypes.push('image');
      if (!chkSvg || chkSvg.checked) selectedTypes.push('svg');
      if (chkVid && chkVid.checked) selectedTypes.push('video');
      if (chkAud && chkAud.checked) selectedTypes.push('audio');
      if (selectedTypes.length === 0) {
        selectedTypes.push('image', 'svg');
      }

      let mediaMaxCount: number = 200;
      const activeCountChip = document.querySelector('#mediaCountChips .chip-option.active');
      if (activeCountChip) {
        const val = activeCountChip.getAttribute('data-val');
        if (val === 'unlimited' || val === '999') mediaMaxCount = Infinity;
        else if (val) mediaMaxCount = parseInt(val, 10) || 200;
      }

      let mediaMaxBytes: number = 50 * 1024 * 1024;
      const activeSizeChip = document.querySelector('#mediaSizeChips .chip-option.active');
      if (activeSizeChip) {
        const val = activeSizeChip.getAttribute('data-val');
        if (val === 'unlimited' || val === '999') mediaMaxBytes = Infinity;
        else if (val) mediaMaxBytes = (parseInt(val, 10) || 50) * 1024 * 1024;
      }

      const parser = new DOMParser();
      const domDoc = parser.parseFromString(pageRawHtml, 'text/html');
      const candidates = collectMediaFromDom(domDoc, url || 'http://localhost', selectedTypes);

      if (!candidates || candidates.length === 0) {
        isCapturing = false;
        setState('erro', {
          errorTitle: 'Nenhuma mídia encontrada',
          errorDetail: 'Nenhuma mídia encontrada nesta página',
          isEmptyMedia: true,
          url
        });
        return;
      }

      let res: any = null;
      res = await captureMediaZip({
        candidates,
        title,
        pageUrl: url,
        types: selectedTypes,
        maxItems: mediaMaxCount,
        maxPerItemBytes: mediaMaxBytes,
        foldersByType: true,
        shouldSkipCurrent: () => {
          if (requestSkipCurrentRequested) {
            requestSkipCurrentRequested = false;
            return true;
          }
          return false;
        },
        shouldStop: () => requestStopAndSaveRequested || isCaptureCancelled,
        onProgress: (loaded: number, total: number, item?: string) => {
          const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
          const elapsed = formatTimer((performance.now() - startTime) / 1000);
          setState('baixando', {
            pct,
            loaded,
            total,
            currentItem: item || 'Gravando mídia...',
            pagesDone: 1,
            pagesTotal: 1,
            mb: ((loaded * 80) / 1024).toFixed(1).replace('.', ','),
            elapsedTime: elapsed,
            nextItem: 'Galeria de mídias',
            nextDesc: `${Math.max(0, total - loaded)} itens restantes`
          });
        }
      });

      if (!res?.stats || res.stats.savedAssets === 0) {
        isCapturing = false;
        setState('erro', {
          errorTitle: 'Nenhuma mídia encontrada',
          errorDetail: 'Nenhuma mídia encontrada nesta página',
          isEmptyMedia: true,
          url
        });
        return;
      }

      await triggerBrowserDownload(res.blob, res.filename);
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1).replace('.', ',');
      const sizeText = formatBytes(res.blob.size);

      setState('pronto', {
        filename: res.filename,
        sizeText,
        pages: 1,
        totalAssets: res.stats.totalAssets,
        imagesCount: res.stats.savedAssets,
        cssCount: 0,
        fontsCount: 0,
        corsErrors: res.stats.corsBlockedAssets || 0,
        timeoutErrors: 0,
        elapsedTime: elapsed
      });
      return;
    }

    // 3. Captura Completa Fiel (ZIP) - Escopos esta_pagina, paginas_vinculadas ou site_inteiro
    const crawlMode = currentScope === 'esta_pagina' ? 'page' : (currentScope === 'paginas_vinculadas' ? 'linked' : 'site');
    let result: any = null;
    result = await captureFaithfulSite({
      tabId: tabId || undefined,
      url,
      title,
      html: pageRawHtml,
      mode: crawlMode,
      limits: {
        maxPages: limitPages,
        maxDepth: limitDepth,
        maxBytes: limitMb * 1024 * 1024,
        includeSubdomains,
        allowedExternalDomains: Array.from(confirmedExternalDomains)
      },
      autoscroll: false, // autoscroll já foi executado na fase rolando
      autoscrollOptions: getActiveAutoscrollOptions(),
      recorder: existingRecorder || undefined,
      tabGuard: guard,
      shouldSkipCurrent: () => {
        if (requestSkipCurrentRequested) {
          requestSkipCurrentRequested = false;
          return true;
        }
        return false;
      },
      shouldStop: () => requestStopAndSaveRequested || isCaptureCancelled,
      onProgress: async (loaded, total, item) => {
        while (isCapturePaused && !isCaptureCancelled) {
          await new Promise((r) => setTimeout(r, 200));
        }

        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        const elapsed = formatTimer((performance.now() - startTime) / 1000);
        const estMb = ((loaded * 80) / 1024).toFixed(1).replace('.', ',');

        setState('baixando', {
          pct,
          loaded,
          total,
          currentItem: item || 'Compactando...',
          pagesDone: currentScope === 'esta_pagina' ? 1 : (result?.stats?.totalPages || 1),
          pagesTotal: currentScope === 'esta_pagina' ? 1 : Math.min(12, limitPages),
          mb: estMb,
          elapsedTime: elapsed,
          nextItem: item || 'Próximo recurso',
          nextDesc: 'Processamento local fflate'
        });
      }
    });

    if (result?.interrupted || guard?.reason) {
      isCapturing = false;
      const reason = (result?.interrupted || guard?.reason || 'navigated_away') as 'tab_closed' | 'navigated_away';
      const errorMsg = reason === 'tab_closed'
        ? 'A aba foi fechada durante a captura.'
        : 'A aba foi para outro site durante a captura.';
      const totalAssets = result?.stats?.totalAssets || 0;
      const retainedText = `${totalAssets} RECURSO${totalAssets === 1 ? '' : 'S'} SALVO${totalAssets === 1 ? '' : 'S'}`;
      const finalFilename = result?.filename || getLockedCaptureZipFilename();
      setState('gravacao_erro', {
        errorMsg,
        retainedText,
        partialBlob: result?.blob || null,
        partialFilename: finalFilename,
        isInterrupted: true,
        reason
      });
      return;
    }

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
      elapsedTime: elapsed,
      warnings: result.warnings
    });
  } catch (err: any) {
    isCapturing = false;
    console.error('Erro na captura:', err);
    const isDebuggerDetached =
      err?.code === 'DEBUGGER_DETACHED' ||
      err?.name === 'PluckDebuggerDetachedError' ||
      (typeof err?.message === 'string' && (
        err.message.includes('DEBUGGER_DETACHED') ||
        err.message.includes('depuração') ||
        err.message.includes('Debugger was detached') ||
        err.message.includes('detached')
      ));

    if (isDebuggerDetached) {
      setState('erro', {
        errorTitle: 'Depuração encerrada',
        errorDetail: 'A captura foi interrompida porque a depuração foi encerrada.',
        isDebuggerDetached: true,
        url
      });
    } else {
      setState('erro', {
        errorTitle: 'Falha na Captura do Documento',
        errorDetail: err?.message || 'O documento HTML da página não pôde ser obtido ou está vazio.',
        url
      });
    }
  } finally {
    isCapturing = false;
    if (guard) {
      guard.stop();
    }
    if (existingRecorder) {
      await existingRecorder.stop().catch(() => {});
    }
  }
}


// --------------------------------------------------------------------------
// DISPARO SEGURO DE DOWNLOAD NO NAVEGADOR E RETENÇÃO EM MEMÓRIA (SPEC-v12)
// --------------------------------------------------------------------------
export async function downloadAgain(): Promise<void> {
  // SPEC-v12: Baixar novamente funciona com qualquer aba ativa enquanto o painel estiver aberto
  if (inMemoryArchivedFile) {
    try {
      await triggerBrowserDownload(inMemoryArchivedFile.blob, inMemoryArchivedFile.filename);
      return;
    } catch (err) {
      console.warn('Erro ao rebaixar via inMemoryArchivedFile:', err);
    }
  }

  if (!lastDownloadInfo) return;
  try {
    const binary = atob(lastDownloadInfo.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const mime = lastDownloadInfo.filename.endsWith('.html') ? 'text/html' : 'application/zip';
    const blob = new Blob([bytes], { type: mime });
    await triggerBrowserDownload(blob, lastDownloadInfo.filename);
  } catch (err) {
    console.warn('Erro ao rebaixar arquivo em memória:', err);
  }
}

// --------------------------------------------------------------------------
// GRAVAÇÃO MANUAL DE SESSÃO NA PÁGINA ATIVA (SPEC-v12)
// --------------------------------------------------------------------------
export async function handleStartRecording(): Promise<void> {
  if (!currentTabUrl || !validateUrl(currentTabUrl, true).valid || isSystemBrowserPage(currentTabUrl)) {
    setState('erro');
    return;
  }
  if (!currentTabId) {
    setState('sem_acesso');
    return;
  }

  lockedCaptureTabId = currentTabId;
  lockedCaptureUrl = currentTabUrl;
  lockedCaptureOrigin = currentTabOrigin;
  lockedCaptureTitle = currentTabTitle;

  try {
    await sessionRecorder.start(currentTabId, currentTabUrl, (errorMsg, state) => {
      let retainedText: string | undefined;
      if (recordingStartTime) {
        const elapsedSec = Math.floor((Date.now() - recordingStartTime) / 1000);
        if (elapsedSec > 0) {
          const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
          const s = String(elapsedSec % 60).padStart(2, '0');
          retainedText = `${m}:${s} DE INTERAÇÕES SALVAS`;
        }
      }
      setState('gravacao_erro', { errorMsg, navigatedToUrl: state.navigatedToUrl, retainedText, isInterrupted: false });
    });
    setState('gravando');
  } catch (err) {
    console.warn('Erro ao iniciar SessionRecorder:', err);
  }
}

export async function handleStopRecording(): Promise<void> {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  const { resources } = await sessionRecorder.stop();
  await finishRecordingCapture(resources);
}

export async function handleSaveRecorded(): Promise<void> {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  const { resources } = await sessionRecorder.stop();
  await finishRecordingCapture(resources);
}

export function handleRestartRecording(): void {
  resetToInitialState();
}

export async function finishRecordingCapture(resources: CapturedResource[]): Promise<void> {
  const startTime = performance.now();
  const targetUrl = lockedCaptureUrl || currentTabUrl;
  const targetTitle = lockedCaptureTitle || currentTabTitle;
  const targetId = lockedCaptureTabId || currentTabId;

  setState('baixando', {
    pct: 0,
    loaded: resources.length,
    total: Math.max(1, resources.length),
    currentItem: 'Processando recursos gravados...',
    pagesDone: 1,
    pagesTotal: 1,
    mb: '0,1',
    elapsedTime: '00:00',
    nextItem: targetTitle,
    nextDesc: 'Compactando recursos capturados na sessão'
  });

  try {
    let pageRawHtml = targetTabOverrideHtml || '';
    if (!pageRawHtml && typeof chrome !== 'undefined' && chrome.scripting && targetId) {
      try {
        const [{ result: pageData }] = await chrome.scripting.executeScript({
          target: { tabId: targetId },
          func: (serializeFnCode: string) => {
            try {
              const fn = new Function('return (' + serializeFnCode + ')()');
              const s = fn();
              if (s && s.length > 50) return s;
            } catch {}
            return document.documentElement.outerHTML;
          },
          args: [serializeLiveDom.toString()]
        });
        if (pageData) pageRawHtml = pageData;
      } catch (e) {
        console.warn('Erro ao obter DOM na finalização da gravação:', e);
      }
    }

    if (!isValidDocumentHtml(pageRawHtml)) {
      pageRawHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${targetTitle || 'Página'}</title></head><body><h1>${targetTitle || 'Página Gravada'}</h1></body></html>`;
    }

    let result: any = null;
    result = await captureFaithfulSite({
      tabId: targetId || undefined,
      url: targetUrl,
      title: targetTitle,
      html: pageRawHtml,
      mode: 'page',
      limits: {
        maxPages: 1,
        maxBytes: limitMb * 1024 * 1024,
        includeSubdomains: false
      },
      autoscroll: false,
      customResources: resources,
      onProgress: (loaded, total, item) => {
        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        const elapsed = formatTimer((performance.now() - startTime) / 1000);
        setState('baixando', {
          pct,
          loaded,
          total,
          currentItem: item || 'Compactando gravação...',
          pagesDone: 1,
          pagesTotal: 1,
          mb: ((loaded * 80) / 1024).toFixed(1).replace('.', ','),
          elapsedTime: elapsed
        });
      }
    });

    await triggerBrowserDownload(result.blob, result.filename);

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1).replace('.', ',');
    const sizeText = formatBytes(result.blob.size);

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
    console.error('Erro ao finalizar gravação manual:', err);
    setState('erro', {
      errorTitle: 'Falha ao Salvar Gravação',
      errorDetail: err?.message || 'Não foi possível empacotar os recursos gravados.',
      url: currentTabUrl
    });
  }
}

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
    inMemoryArchivedFile = {
      filename,
      blob,
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

  const isBusyState = currentState === 'baixando' || currentState === 'rolando' || currentState === 'analisando' || currentState === 'pronto' || currentState === 'gravacao_erro' || currentState === 'gravando' || isCapturing;
  if (isBusyState) {
    return;
  }

  try {
    const targetTab = tabOverride !== undefined ? tabOverride : (await getPanelActiveTab());

    if (!targetTab) {
      currentTabId = null;
      currentTabUrl = '';
      currentTabTitle = 'Nenhuma aba ativa';
      const oTitle = document.getElementById('originTitle');
      const oUrl = document.getElementById('originUrl');
      if (oTitle) oTitle.textContent = currentTabTitle;
      if (oUrl) oUrl.textContent = '—';
      updateSecurityPillForHiddenUrl();
      setState('sem_acesso');
      return;
    }

    currentTabId = targetTab.id ?? null;

    // CENÁRIO 1: O navegador ocultou a URL da aba (falta de permissão 'tabs' ou aba restrita)
    if (!targetTab.url) {
      if (isBusyState) {
        return;
      }
      currentTabUrl = '';
      currentTabTitle = targetTab.title || 'Aba ativa (identificação oculta)';
      currentTabOrigin = '';
      const oTitle = document.getElementById('originTitle');
      const oUrl = document.getElementById('originUrl');
      if (oTitle) oTitle.textContent = currentTabTitle;
      if (oUrl) oUrl.textContent = 'URL oculta pelo navegador · Permissão necessária';
      updateSecurityPillForHiddenUrl();
      setState('sem_acesso');
      return;
    }

    // Se for a própria página da extensão, ignora para não sobrescrever a aba inspecionada
    if (targetTab.url.startsWith('chrome-extension://') && targetTab.url.includes(chrome.runtime?.id || 'pluck')) {
      return;
    }

    currentTabUrl = targetTab.url;
    currentTabTitle = targetTab.title || 'Página Web';

    let cleanHost = '';
    try {
      const parsed = new URL(currentTabUrl);
      currentTabOrigin = parsed.origin;
      cleanHost = parsed.hostname.replace(/^www\./, '') || parsed.protocol.replace(':', '');
    } catch {
      currentTabOrigin = '';
    }

    const oTitle = document.getElementById('originTitle');
    const oUrl = document.getElementById('originUrl');
    if (oTitle) oTitle.textContent = cleanHost || currentTabTitle;
    if (oUrl) oUrl.textContent = currentTabUrl;

    // Validação de acessibilidade da página (Grupo A - Páginas sem acesso)
    const access = checkPageAccessibility(currentTabUrl, currentTabTitle);
    updateSecurityPill(currentTabUrl, targetTab.status);

    if (!access.accessible) {
      if (!isBusyState && currentState === 'inicio') {
        renderFooterActions();
      }
      return;
    }

    const popRes = document.getElementById('popover-resolution');
    if (popRes) {
      const w = targetTab.width || (typeof window !== 'undefined' ? window.screen?.width || 1440 : 1440);
      const h = targetTab.height || (typeof window !== 'undefined' ? window.screen?.height || 900 : 900);
      popRes.textContent = `${w}×${h} PX`;
    }

    if (validateUrl(currentTabUrl, true).valid) {
      if (currentState === 'erro' || currentState === 'sem_acesso') {
        setState('inicio');
      } else if (currentState === 'inicio') {
        renderFooterActions();
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
    brandTag.textContent = 'v0.2';
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
  const mPiece = document.getElementById('mode-piece');
  const mHtml = document.getElementById('mode-html');
  const mImgs = document.getElementById('mode-images');
  const mSite = document.getElementById('mode-site');
  if (mZip) {
    mZip.onclick = () => selectMode('zip');
    mZip.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        selectMode('zip');
      }
    };
  }
  if (mPiece) {
    mPiece.onclick = () => selectMode('piece');
    mPiece.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        selectMode('piece');
      }
    };
  }
  if (mHtml) {
    mHtml.onclick = () => selectMode('html');
    mHtml.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        selectMode('html');
      }
    };
  }
  if (mImgs) {
    mImgs.onclick = () => selectMode('images');
    mImgs.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        selectMode('images');
      }
    };
  }
  if (mSite) {
    mSite.onclick = () => selectMode('site');
    mSite.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        selectMode('site');
      }
    };
  }

  // Bind Botões de Configuração de Opções (v12)
  const btnCfgSite = document.getElementById('btnConfigSite');
  if (btnCfgSite) {
    const openSiteOpt = (e: Event) => {
      e.stopPropagation();
      selectMode('site');
      setState('opcoes', { subview: 'site' });
    };
    btnCfgSite.onclick = openSiteOpt;
    btnCfgSite.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        openSiteOpt(e);
      }
    };
  }

  const btnCfgMidias = document.getElementById('btnConfigMidias');
  if (btnCfgMidias) {
    const openMidiasOpt = (e: Event) => {
      e.stopPropagation();
      selectMode('images');
      setState('opcoes', { subview: 'midias' });
    };
    btnCfgMidias.onclick = openMidiasOpt;
    btnCfgMidias.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        openMidiasOpt(e);
      }
    };
  }

  const btnBackOpt = document.getElementById('btnBackFromOptions');
  if (btnBackOpt) {
    btnBackOpt.onclick = () => {
      setState('inicio');
    };
  }

  const btnSaveOpt = document.getElementById('btnSaveOptions');
  if (btnSaveOpt) {
    btnSaveOpt.onclick = () => {
      setState('inicio');
    };
  }

  // Bind Opções de Site Inteiro (Chips & Subdomínios)
  const sitePages = document.querySelectorAll('#sitePagesChips .chip-option');
  sitePages.forEach((c) => {
    const handleSelect = () => {
      sitePages.forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
        (x as HTMLElement).tabIndex = -1;
      });
      c.classList.add('active');
      c.setAttribute('aria-checked', 'true');
      (c as HTMLElement).tabIndex = 0;
      const val = parseInt(c.getAttribute('data-val') || '20', 10);
      setLimitPage(val);
    };
    (c as HTMLElement).onclick = handleSelect;
    (c as HTMLElement).onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        handleSelect();
      }
    };
  });

  const siteDepth = document.querySelectorAll('#siteDepthChips .chip-option');
  siteDepth.forEach((c) => {
    const handleSelect = () => {
      siteDepth.forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
        (x as HTMLElement).tabIndex = -1;
      });
      c.classList.add('active');
      c.setAttribute('aria-checked', 'true');
      (c as HTMLElement).tabIndex = 0;
      const raw = c.getAttribute('data-val');
      limitDepth = raw === '999' ? Infinity : parseInt(raw || '2', 10);
    };
    (c as HTMLElement).onclick = handleSelect;
    (c as HTMLElement).onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        handleSelect();
      }
    };
  });

  const siteSubSw = document.getElementById('siteSubdomainsSwitch');
  if (siteSubSw) {
    const toggleSub = () => {
      includeSubdomains = !includeSubdomains;
      siteSubSw.className = includeSubdomains ? 'switch-track' : 'switch-track off';
      siteSubSw.setAttribute('aria-checked', includeSubdomains ? 'true' : 'false');
    };
    siteSubSw.onclick = toggleSub;
    siteSubSw.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        toggleSub();
      }
    };
  }

  // Bind Opções de Mídias (Filtros & Limites)
  ['Img', 'Svg', 'Vid', 'Aud'].forEach((key) => {
    const card = document.getElementById(`mediaCard${key}`);
    const chk = document.getElementById(`mediaCheck${key}`) as HTMLInputElement;
    if (card && chk) {
      const updateVisual = () => {
        const checkIcon = card.querySelector('.custom-check');
        if (chk.checked) {
          card.classList.add('active');
          checkIcon?.classList.add('checked');
        } else {
          card.classList.remove('active');
          checkIcon?.classList.remove('checked');
        }
      };

      // O card é um <label> contendo o checkbox. O navegador já inverte nativamente o input
      // ao clicar no label. Ouvir 'change' no input evita o bug de inversão dupla que existia com onclick.
      chk.addEventListener('change', updateVisual);
      updateVisual();
    }
  });

  const mCounts = document.querySelectorAll('#mediaCountChips .chip-option');
  mCounts.forEach((c) => {
    const handleSelect = () => {
      mCounts.forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
        (x as HTMLElement).tabIndex = -1;
      });
      c.classList.add('active');
      c.setAttribute('aria-checked', 'true');
      (c as HTMLElement).tabIndex = 0;
    };
    (c as HTMLElement).onclick = handleSelect;
    (c as HTMLElement).onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        handleSelect();
      }
    };
  });

  const mSizes = document.querySelectorAll('#mediaSizeChips .chip-option');
  mSizes.forEach((c) => {
    const handleSelect = () => {
      mSizes.forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-checked', 'false');
        (x as HTMLElement).tabIndex = -1;
      });
      c.classList.add('active');
      c.setAttribute('aria-checked', 'true');
      (c as HTMLElement).tabIndex = 0;
    };
    (c as HTMLElement).onclick = handleSelect;
    (c as HTMLElement).onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        handleSelect();
      }
    };
  });

  const cardScreens = document.getElementById('scrollCardScreens');
  const cardTime = document.getElementById('scrollCardTime');
  const cardUnlimited = document.getElementById('scrollCardUnlimited');
  if (cardScreens) {
    cardScreens.onclick = () => setScrollLimitChoice('10');
    cardScreens.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        setScrollLimitChoice('10');
      }
    };
  }
  if (cardTime) {
    cardTime.onclick = () => setScrollLimitChoice('30');
    cardTime.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        setScrollLimitChoice('30');
      }
    };
  }
  if (cardUnlimited) {
    cardUnlimited.onclick = () => setScrollLimitChoice('unlimited');
    cardUnlimited.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        setScrollLimitChoice('unlimited');
      }
    };
  }

  const scrollChips = document.querySelectorAll('#scrollLimitChips .chip-option');
  scrollChips.forEach((c) => {
    const handleSelect = () => {
      const v = c.getAttribute('data-val');
      if (v === '30') setScrollLimitChoice('30');
      else if (v === '999' || v === 'unlimited') setScrollLimitChoice('unlimited');
      else setScrollLimitChoice('10');
    };
    (c as HTMLElement).onclick = handleSelect;
    (c as HTMLElement).onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        handleSelect();
      }
    };
  });

  // Bind Linhas de Opção de Captura (Automático x Gravação manual com rádio exclusivo)
  const optAuto = document.getElementById('optAutoRow');
  const optRec = document.getElementById('optRecRow');
  const autoCircle = document.getElementById('autoRadioCircle');
  const recCircle = document.getElementById('recRadioCircle');

  const selectAutoMethod = () => {
    captureMethod = 'automatic';
    autoscrollOn = true;
    if (autoSw) {
      autoSw.className = 'switch-track';
      autoSw.setAttribute('aria-checked', 'true');
    }
    if (recSw) {
      recSw.className = 'switch-track off';
      recSw.setAttribute('aria-checked', 'false');
    }
    if (autoCircle) {
      autoCircle.classList.add('active');
      autoCircle.innerHTML = '<div class="radio-dot"></div>';
    }
    if (recCircle) {
      recCircle.classList.remove('active');
      recCircle.innerHTML = '';
    }
    if (optAuto) {
      optAuto.classList.add('selected');
      optAuto.setAttribute('aria-checked', 'true');
      optAuto.tabIndex = 0;
    }
    if (optRec) {
      optRec.classList.remove('selected');
      optRec.setAttribute('aria-checked', 'false');
      optRec.tabIndex = -1;
    }
    if (currentState === 'inicio') renderFooterActions();
  };

  const selectRecordingMethod = () => {
    captureMethod = 'recording';
    autoscrollOn = false;
    if (recSw) {
      recSw.className = 'switch-track';
      recSw.setAttribute('aria-checked', 'true');
    }
    if (autoSw) {
      autoSw.className = 'switch-track off';
      autoSw.setAttribute('aria-checked', 'false');
    }
    if (recCircle) {
      recCircle.classList.add('active');
      recCircle.innerHTML = '<div class="radio-dot"></div>';
    }
    if (autoCircle) {
      autoCircle.classList.remove('active');
      autoCircle.innerHTML = '';
    }
    if (optRec) {
      optRec.classList.add('selected');
      optRec.setAttribute('aria-checked', 'true');
      optRec.tabIndex = 0;
    }
    if (optAuto) {
      optAuto.classList.remove('selected');
      optAuto.setAttribute('aria-checked', 'false');
      optAuto.tabIndex = -1;
    }
    setScope('esta_pagina');
    if (currentState === 'inicio') renderFooterActions();
  };

  if (optAuto) {
    optAuto.onclick = selectAutoMethod;
    optAuto.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        selectAutoMethod();
      }
    };
  }
  if (optRec) {
    optRec.onclick = selectRecordingMethod;
    optRec.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        selectRecordingMethod();
      }
    };
  }

  // Bind Record Clicks Switch (v11/v12: Gravação manual x Automático)
  const recSw = document.getElementById('recordClicksSwitch');
  const autoSw = document.getElementById('autoSwitch');

  if (recSw) {
    recSw.onclick = () => {
      const willBeActive = !recSw.classList.contains('switch-track') || recSw.classList.contains('off');
      if (willBeActive) {
        captureMethod = 'recording';
        recSw.className = 'switch-track';
        recSw.setAttribute('aria-checked', 'true');
        if (autoSw) {
          autoSw.className = 'switch-track off';
          autoSw.setAttribute('aria-checked', 'false');
          autoscrollOn = false;
        }
        setScope('esta_pagina');
      } else {
        captureMethod = 'automatic';
        recSw.className = 'switch-track off';
        recSw.setAttribute('aria-checked', 'false');
        if (autoSw) {
          autoSw.className = 'switch-track';
          autoSw.setAttribute('aria-checked', 'true');
          autoscrollOn = true;
        }
      }
      if (currentState === 'inicio') renderFooterActions();
    };
    recSw.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        recSw.click();
      }
    };
  }

  // Setup keyboard arrow navigation for radio groups
  function setupRadioArrowNav(containerSelector: string, itemSelector: string) {
    const container = document.querySelector(containerSelector);
    if (!container) return;
    container.addEventListener('keydown', (e: Event) => {
      const keyEv = e as KeyboardEvent;
      if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(keyEv.key)) {
        const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector)).filter(
          (el) => el.offsetParent !== null || el.getAttribute('role') === 'radio'
        );
        const focusedIndex = items.indexOf(document.activeElement as HTMLElement);
        if (focusedIndex === -1) return;
        keyEv.preventDefault();
        let nextIndex = focusedIndex;
        if (keyEv.key === 'ArrowDown' || keyEv.key === 'ArrowRight') {
          nextIndex = (focusedIndex + 1) % items.length;
        } else if (keyEv.key === 'ArrowUp' || keyEv.key === 'ArrowLeft') {
          nextIndex = (focusedIndex - 1 + items.length) % items.length;
        }
        const target = items[nextIndex];
        if (target) {
          items.forEach((item) => {
            item.tabIndex = item === target ? 0 : -1;
          });
          target.focus();
          target.click();
        }
      }
    });
  }

  setupRadioArrowNav('.mode-options-group', '.mode-card');
  setupRadioArrowNav('.capture-mode-container', '.capture-option-row');
  setupRadioArrowNav('#sitePagesChips', '.chip-option');
  setupRadioArrowNav('#siteDepthChips', '.chip-option');
  setupRadioArrowNav('#mediaCountChips', '.chip-option');
  setupRadioArrowNav('#mediaSizeChips', '.chip-option');
  setupRadioArrowNav('#subview-opcoes-rolagem', '.mode-card');
  setupRadioArrowNav('#scrollLimitChips', '.chip-option');

  // Bind Autoscroll Switch
  if (autoSw) {
    autoSw.onclick = () => {
      const willBeActive = !autoSw.classList.contains('switch-track') || autoSw.classList.contains('off');
      if (willBeActive) {
        captureMethod = 'automatic';
        autoscrollOn = true;
        autoSw.className = 'switch-track';
        autoSw.setAttribute('aria-checked', 'true');
        if (recSw) {
          recSw.className = 'switch-track off';
          recSw.setAttribute('aria-checked', 'false');
        }
      } else {
        autoscrollOn = false;
        autoSw.className = 'switch-track off';
        autoSw.setAttribute('aria-checked', 'false');
      }
      if (currentState === 'inicio') renderFooterActions();
    };
    autoSw.onkeydown = (e) => {
      if (isActionKey(e)) {
        e.preventDefault();
        autoSw.click();
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
      if (isActionKey(e)) {
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

  if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onDetach) {
    chrome.debugger.onDetach.addListener((source, reason) => {
      const isTargetTab = source.tabId === currentTabId || (lockedCaptureTabId !== null && source.tabId === lockedCaptureTabId);
      if (isTargetTab && (currentState === 'rolando' || currentState === 'baixando' || isCapturing)) {
        isCaptureCancelled = true;
        isCapturing = false;
        if (reason === 'target_closed') {
          setState('gravacao_erro', {
            errorMsg: 'A aba foi fechada durante a captura.',
            retainedText: '0 RECURSOS SALVOS',
            partialFilename: getLockedCaptureZipFilename(),
            isInterrupted: true,
            reason: 'tab_closed'
          });
        } else {
          setState('erro', {
            errorTitle: 'Depuração encerrada',
            errorDetail: 'A captura foi interrompida porque a depuração foi encerrada.',
            isDebuggerDetached: true,
            url: lockedCaptureUrl || currentTabUrl
          });
        }
      }
    });
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
  setupPopoverEvents();
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
    resetToInitialState,
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
    getActiveAutoscrollOptions,
    setScrollLimitChoice,
    getLimits: () => ({ limitPages, limitDepth, limitMb, includeSubdomains }),
    getLastDownload: () => lastDownloadInfo,
    clearLastDownload: () => { lastDownloadInfo = null; isCapturing = false; },
    getInMemoryArchivedFile: () => inMemoryArchivedFile,
    setInMemoryArchivedFile: (f: typeof inMemoryArchivedFile) => { inMemoryArchivedFile = f; },
    isStopAndSaveRequested: () => requestStopAndSaveRequested,
    isSkipCurrentRequested: () => requestSkipCurrentRequested,
    isCapturing: () => isCapturing,
    checkPageAccessibility,
    downloadAgain: () => downloadAgain(),
    handleStartRecording: () => handleStartRecording(),
    handleStopRecording: () => handleStopRecording(),
    handleSaveRecorded: () => handleSaveRecorded(),
    handleRestartRecording: () => handleRestartRecording(),
    finishRecordingCapture: (res: any[]) => finishRecordingCapture(res),
    getCaptureMethod: () => captureMethod,
    setCaptureMethod: (m: 'automatic' | 'recording') => {
      captureMethod = m;
      if (currentState === 'inicio') renderFooterActions();
    },
    getSessionRecorder: () => sessionRecorder,
    setLoginConsentAccepted: (v: boolean) => { loginConsentAccepted = v; },
    performRealCapture: (recorder?: any) => performRealCapture(recorder),
    handlePrimaryStart: () => handlePrimaryStart(),
    setTargetTab: ({ url, title, html, tabId }: { url?: string; title?: string; html?: string; tabId?: number }) => {
      if (tabId !== undefined) currentTabId = tabId;
      currentTabUrl = (url && url !== 'null' && url !== 'undefined') ? url : '';
      currentTabTitle = title || (currentTabUrl ? 'Página Web' : 'Aba ativa (identificação oculta)');
      targetTabOverrideHtml = html || '';
      try {
        const orig = currentTabUrl ? new URL(currentTabUrl).origin : '';
        currentTabOrigin = (orig && orig !== 'null') ? orig : '';
      } catch {
        currentTabOrigin = '';
      }

      const oTitle = document.getElementById('originTitle');
      const oUrl = document.getElementById('originUrl');
      if (oTitle) oTitle.textContent = currentTabTitle;
      if (oUrl) oUrl.textContent = currentTabUrl || 'URL oculta pelo navegador · Permissão necessária';

      const access = checkPageAccessibility(currentTabUrl, currentTabTitle);
      updateSecurityPill(currentTabUrl);

      if (!access.accessible) {
        if (currentState === 'inicio') {
          renderFooterActions();
        }
        return;
      }

      if (!validateUrl(currentTabUrl, true).valid) {
        setState('erro');
      } else if (currentState === 'erro' || currentState === 'sem_acesso') {
        setState('inicio');
      } else if (currentState === 'inicio') {
        renderFooterActions();
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
