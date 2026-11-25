// Pluck Service Worker (MV3) - Exclusivo Painel Lateral Nativo (chrome.sidePanel)
chrome.runtime.onInstalled.addListener(() => {
  // Configura clique no ícone da extensão para abrir exclusivamente o painel lateral nativo
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn('Erro ao configurar comportamento do sidePanel:', err);
    });
  }
});

// Rastreamento de permissões temporárias ativas associadas a abas
const activeHostPermissions = new Map<number, Set<string>>(); // tabId -> Set de origens

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // [SEC-15] Validação de remetente (defesa em profundidade contra mensagens de origens espúrias)
  if (_sender && _sender.id && _sender.id !== chrome.runtime.id) {
    return;
  }

  if (message && message.type === 'PERMISSION_ACQUIRED') {
    const key = message.tabId || _sender.tab?.id || 0;
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
    const key = message.tabId || _sender.tab?.id || 0;
    if (key && message.origin) {
      activeHostPermissions.get(key)?.delete(message.origin);
    }
    sendResponse({ acknowledged: true });
    return false;
  }

  if (message && message.type === 'PING') {
    sendResponse({ status: 'PONG', timestamp: Date.now() });
    return false;
  }
});

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
