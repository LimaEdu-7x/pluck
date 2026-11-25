// Pluck Service Worker (MV3)
chrome.runtime.onInstalled.addListener(() => {
  // Configura menu de contexto no ícone da extensão para abrir no painel lateral
  if (chrome.contextMenus && typeof chrome.contextMenus.create === 'function') {
    chrome.contextMenus.create({
      id: 'open-sidepanel',
      title: 'Abrir no painel lateral',
      contexts: ['action']
    });
  }

  // O clique no ícone NÃO abre o painel lateral automaticamente, pois a janela horizontal é o padrão
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((err) => {
      console.warn('Erro ao configurar comportamento do sidePanel:', err);
    });
  }
});

// Clique no ícone da barra de ferramentas abre a janela própria (horizontal 720x400)
chrome.action.onClicked.addListener(async () => {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('window.html'),
      type: 'popup',
      width: 736,
      height: 439
    });
  } catch (err) {
    console.error('Erro ao abrir janela horizontal do Pluck:', err);
  }
});

// Ação do menu de contexto: "Abrir no painel lateral"
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-sidepanel' && tab?.id) {
    if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
      } catch (err) {
        console.warn('Erro ao abrir painel lateral via menu:', err);
      }
    }
  }
});

// Rastreamento de permissões temporárias ativas associadas a janelas e abas
const activeHostPermissions = new Map<number, Set<string>>(); // windowId/tabId -> Set de origens

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // [SEC-15] Validação de remetente (defesa em profundidade contra mensagens de origens espúrias)
  if (_sender && _sender.id && _sender.id !== chrome.runtime.id) {
    return;
  }

  if (message && message.type === 'PERMISSION_ACQUIRED') {
    const key = message.windowId || _sender.tab?.windowId || _sender.tab?.id || 0;
    if (key && message.origin) {
      if (!activeHostPermissions.has(key)) {
        activeHostPermissions.set(key, new Set());
      }
      activeHostPermissions.get(key)!.add(message.origin);
    }
    sendResponse({ acknowledged: true });
    return false;
  }

  if (message && message.type === 'PERMISSION_RELEASED') {
    const key = message.windowId || _sender.tab?.windowId || _sender.tab?.id || 0;
    if (key && message.origin) {
      activeHostPermissions.get(key)?.delete(message.origin);
    }
    sendResponse({ acknowledged: true });
    return false;
  }

  if (message && message.type === 'OPEN_HORIZONTAL_WINDOW') {
    chrome.windows.create({
      url: chrome.runtime.getURL('window.html'),
      type: 'popup',
      width: 736,
      height: 439
    }).then((win) => {
      sendResponse({ success: true, windowId: win.id });
    }).catch((err) => {
      sendResponse({ success: false, error: String(err) });
    });
    return true; // Keep message channel open for async response
  }

  if (message && message.type === 'PING') {
    sendResponse({ status: 'PONG', timestamp: Date.now() });
    return false;
  }
});

// Revogação de permissão quando a janela popup é fechada pelo usuário (clique no "X")
if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener(async (windowId) => {
    const origins = activeHostPermissions.get(windowId);
    if (origins && origins.size > 0) {
      for (const origin of origins) {
        try {
          if (chrome.permissions) {
            await chrome.permissions.remove({ origins: [origin] });
          }
        } catch (err) {
          console.warn('Erro ao revogar permissão ao fechar janela:', err);
        }
      }
      activeHostPermissions.delete(windowId);
    }
  });
}

// Revogação de permissão quando uma aba associada ao painel lateral é fechada
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const origins = activeHostPermissions.get(tabId);
    if (origins && origins.size > 0) {
      for (const origin of origins) {
        try {
          if (chrome.permissions) {
            await chrome.permissions.remove({ origins: [origin] });
          }
        } catch (err) {
          console.warn('Erro ao revogar permissão ao fechar aba:', err);
        }
      }
      activeHostPermissions.delete(tabId);
    }
  });
}
