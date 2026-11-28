// Limpeza de Dados Pessoais e Sanitização de Privacidade do Pluck
// Remove inputs preenchidos, tokens e parâmetros sensíveis em URLs, e isola cookies/storage.

export const SENSITIVE_PARAM_NAMES = new Set([
  'token',
  'auth',
  'auth_token',
  'authtoken',
  'key',
  'api_key',
  'apikey',
  'code',
  'sig',
  'signature',
  'session',
  'session_id',
  'sessionid',
  'access_token',
  'accesstoken',
  'id_token',
  'refresh_token',
  'secret',
  'jwt',
  'password',
  'pass',
  'pwd',
  'user_id',
  'userid',
  'email',
  'ticket',
  'nonce',
  'csrf',
  'xsrf',
  'state',
  'client_secret'
]);

/** URLs de extensões do navegador (chrome-extension://, moz-extension://...) nunca entram na cópia. */
export function isBrowserExtensionUrl(urlStr: string): boolean {
  return /^(chrome|moz|safari-web|ms-browser)-extension:/i.test((urlStr || '').trim());
}

/** Converte entidades HTML de atributos (&amp; etc.) para o caractere real, antes de normalizar uma URL. */
export function decodeHtmlEntities(str: string): string {
  if (!str || str.indexOf('&') < 0) return str;
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&#38;|&#x26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/**
 * Remove parâmetros sensíveis (tokens, sessões, chaves, senhas) de uma URL.
 * Suporta tanto URLs absolutas (http/https) quanto caminhos relativos (/rota?token=...).
 */
export function cleanUrlTokens(urlStr: string, base: string = 'http://localhost'): string {
  if (!urlStr || typeof urlStr !== 'string') return urlStr;
  const trimmed = urlStr.trim();
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:')
  ) {
    return urlStr;
  }

  try {
    const isRelative = !trimmed.includes('://') && !trimmed.startsWith('//');
    const parsed = new URL(trimmed, base);

    // t= e r= (token/regiao) de dominio de terceiro: so cortados fora da origem da pagina, para nao mexer no site
    let baseOrigin = '';
    try { baseOrigin = new URL(base).origin; } catch {}
    const isThirdParty = !!baseOrigin && parsed.origin !== baseOrigin;

    let modified = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (
        SENSITIVE_PARAM_NAMES.has(lower) ||
        lower.includes('token') ||
        lower.includes('session') ||
        lower.includes('auth') ||
        lower.includes('secret') ||
        (isThirdParty && (lower === 't' || lower === 'r'))
      ) {
        parsed.searchParams.delete(key);
        modified = true;
      }
    }

    if (!modified) return urlStr;

    if (isRelative) {
      return parsed.pathname + (parsed.search ? parsed.search : '') + (parsed.hash ? parsed.hash : '');
    }
    return parsed.href;
  } catch {
    return urlStr;
  }
}

/**
 * Limpa valores preenchidos em formulários (inputs de texto, textareas, selects)
 * garantindo que dados confidenciais digitados pelo usuário não sejam salvos no arquivo final.
 */
export function cleanFormValues(doc: Document): void {
  // 1. Limpa valores em inputs de texto e campos preenchidos
  const inputs = doc.querySelectorAll('input');
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const type = (inp.getAttribute('type') || 'text').toLowerCase();

    // Senhas são removidas completamente
    if (type === 'password') {
      inp.remove();
      continue;
    }

    // Não limpa botões ou controles binários
    if (
      type === 'button' ||
      type === 'submit' ||
      type === 'reset' ||
      type === 'checkbox' ||
      type === 'radio' ||
      type === 'image'
    ) {
      continue;
    }

    // Se for input oculto com nome sensível, esvazia
    if (type === 'hidden') {
      const name = (inp.getAttribute('name') || inp.getAttribute('id') || '').toLowerCase();
      if (/csrf|token|nonce|authenticity|auth_token|session/i.test(name)) {
        inp.setAttribute('value', '');
      }
      continue;
    }

    // Inputs normais de texto (text, email, tel, number, search, url, etc.): esvazia o value
    if (inp.hasAttribute('value')) {
      inp.setAttribute('value', '');
    }
    // Remove valor em propriedades dinâmicas do elemento se existirem
    try {
      (inp as any).value = '';
    } catch {}
  }

  // 2. Limpa conteúdo digitado em textareas
  const textareas = doc.querySelectorAll('textarea');
  for (let i = 0; i < textareas.length; i++) {
    textareas[i].textContent = '';
    try {
      (textareas[i] as any).value = '';
    } catch {}
  }

  // 3. Reseta selects: desmarca opções dinâmicas excedentes e deixa apenas a primeira
  const selects = doc.querySelectorAll('select');
  for (let i = 0; i < selects.length; i++) {
    const opts = selects[i].querySelectorAll('option');
    for (let j = 0; j < opts.length; j++) {
      if (j === 0) {
        opts[j].setAttribute('selected', '');
      } else {
        opts[j].removeAttribute('selected');
      }
    }
  }

  // 4. Remove meta tags com tokens de sessão ou autenticação
  const metaTokens = doc.querySelectorAll(
    'meta[name*="csrf" i], meta[name*="token" i], meta[name*="auth" i], meta[property*="csrf" i], meta[property*="token" i]'
  );
  for (let i = 0; i < metaTokens.length; i++) {
    metaTokens[i].remove();
  }

  // 5. Remove atributos data-* sensíveis em elementos
  const allElements = doc.querySelectorAll('*');
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    const attrsToRemove: string[] = [];
    for (let a = 0; a < el.attributes.length; a++) {
      const attr = el.attributes[a];
      const lowerName = attr.name.toLowerCase();
      if (
        lowerName.startsWith('data-token') ||
        lowerName.startsWith('data-csrf') ||
        lowerName.startsWith('data-auth') ||
        lowerName.startsWith('data-session')
      ) {
        attrsToRemove.push(attr.name);
      }
    }
    for (const aName of attrsToRemove) {
      el.removeAttribute(aName);
    }
  }
}

/**
 * Remove parâmetros sensíveis (tokens/sessões) de URLs contidas em links e recursos do DOM.
 */
export function cleanAllElementUrlTokens(doc: Document, baseUrl: string = 'http://localhost'): void {
  // Links <a> e <area>
  const links = doc.querySelectorAll('a[href], area[href]');
  for (let i = 0; i < links.length; i++) {
    const el = links[i];
    const href = el.getAttribute('href');
    if (href) {
      el.setAttribute('href', cleanUrlTokens(href, baseUrl));
    }
  }

  // Recursos estáticos com src ou href: link, img, script, iframe, audio, video, source
  const srcElements = doc.querySelectorAll('link[href], img[src], script[src], iframe[src], audio[src], video[src], source[src]');
  for (let i = 0; i < srcElements.length; i++) {
    const el = srcElements[i];
    if (el.hasAttribute('href')) {
      const href = el.getAttribute('href')!;
      el.setAttribute('href', cleanUrlTokens(href, baseUrl));
    }
    if (el.hasAttribute('src')) {
      const src = el.getAttribute('src')!;
      el.setAttribute('src', cleanUrlTokens(src, baseUrl));
    }
  }

  // Formulários formaction / action
  const formActions = doc.querySelectorAll('form[action], [formaction]');
  for (let i = 0; i < formActions.length; i++) {
    const el = formActions[i];
    if (el.hasAttribute('action')) {
      const act = el.getAttribute('action')!;
      el.setAttribute('action', cleanUrlTokens(act, baseUrl));
    }
    if (el.hasAttribute('formaction')) {
      const fa = el.getAttribute('formaction')!;
      el.setAttribute('formaction', cleanUrlTokens(fa, baseUrl));
    }
  }
}
