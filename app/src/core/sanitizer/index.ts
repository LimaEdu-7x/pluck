import { cleanFormValues, cleanAllElementUrlTokens } from '../security/privacy-cleaner';

const CSP_DIRECTIVE =
  "default-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export interface SanitizeOptions {
  removeScripts?: boolean;
  removeHiddenInputs?: boolean;
  removePasswordInputs?: boolean;
  removeNonces?: boolean;
  injectCsp?: boolean;
  cleanPersonalData?: boolean;
}

/**
 * [SEC-12] Sanitiza uma string HTML usando a API DOMParser.
 * NOTA DE ARQUITETURA: DOMParser não existe no contexto de Service Worker MV3.
 * Esta função DEVE ser executada exclusivamente em contextos com DOM
 * (painel lateral sidepanel.html, janela horizontal window.html ou offscreen document).
 */
export function sanitizeHtml(html: string, options: SanitizeOptions = {}): string {
  if (typeof DOMParser === 'undefined') {
    throw new Error(
      'Pluck sanitizeHtml requer um ambiente com DOMParser (janela, sidepanel ou offscreen document). Não execute em Service Worker MV3.'
    );
  }

  const {
    removeScripts = true,
    removeHiddenInputs = true,
    removePasswordInputs = true,
    removeNonces = true,
    injectCsp = true,
    cleanPersonalData = true
  } = options;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  if (removeScripts) {
    // [SEC-06] Remove tags de script e elementos executáveis incorporados
    const scripts = doc.querySelectorAll('script, noscript, embed, object, applet');
    scripts.forEach((el) => el.remove());

    const allElements = doc.querySelectorAll('*');
    for (const el of allElements) {
      const attrsToRemove: string[] = [];
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        const name = attr.name.toLowerCase();
        // Normaliza espaços e caracteres de controle (tabs, quebras de linha e \x00-\x20)
        const val = attr.value.replace(/[\x00-\x20\s]/g, '').toLowerCase();

        if (name.startsWith('on')) {
          attrsToRemove.push(attr.name);
        } else if (
          name === 'href' ||
          name === 'src' ||
          name === 'action' ||
          name === 'formaction' ||
          name === 'data' ||
          name === 'poster' ||
          name === 'codebase' ||
          name === 'archive'
        ) {
          // [SEC-06] Bloqueia esquemas perigosos e data URIs com tipos HTML executáveis
          if (
            val.startsWith('javascript:') ||
            val.startsWith('vbscript:') ||
            val.startsWith('data:text/html') ||
            val.startsWith('data:text/xhtml') ||
            val.startsWith('data:application/xhtml+xml')
          ) {
            attrsToRemove.push(attr.name);
          }
        }
      }
      for (const attrName of attrsToRemove) {
        el.removeAttribute(attrName);
      }
    }

    // [SEC-07] Neutraliza formulários e remove formas de exfiltração de dados
    const forms = doc.querySelectorAll('form');
    forms.forEach((form) => {
      form.setAttribute('action', '#');
      form.removeAttribute('formaction');
    });

    const submitControls = doc.querySelectorAll(
      'input[type="submit"], button[type="submit"], form button:not([type="button"]), form input[type="image"]'
    );
    submitControls.forEach((sub) => {
      sub.setAttribute('disabled', '');
      sub.removeAttribute('formaction');
    });

    const allFormActions = doc.querySelectorAll('[formaction]');
    allFormActions.forEach((fa) => fa.removeAttribute('formaction'));

    // [SEC-01] Neutraliza iframes: remove srcdoc (bypass XSS) e força sandbox
    const iframes = doc.querySelectorAll('iframe');
    iframes.forEach((frame) => {
      frame.removeAttribute('srcdoc');
      frame.setAttribute('sandbox', '');
    });
  }

  if (removeNonces) {
    const nonceElements = doc.querySelectorAll('[nonce], [integrity]');
    nonceElements.forEach((el) => {
      el.removeAttribute('nonce');
      el.removeAttribute('integrity');
    });
  }

  if (removePasswordInputs) {
    const passwords = doc.querySelectorAll('input[type="password"]');
    passwords.forEach((el) => el.remove());
  }

  if (removeHiddenInputs) {
    const hiddenInputs = doc.querySelectorAll('input[type="hidden"]');
    hiddenInputs.forEach((el) => el.remove());

    const sensitiveInputs = doc.querySelectorAll(
      'input[name*="csrf" i], input[name*="token" i], input[name*="nonce" i], input[id*="csrf" i]'
    );
    sensitiveInputs.forEach((el) => el.remove());
  }

  if (cleanPersonalData) {
    cleanFormValues(doc);
    cleanAllElementUrlTokens(doc);
  }

  // Remove existing base tag
  const existingBases = doc.querySelectorAll('base');
  existingBases.forEach((b) => b.remove());

  // [SEC-03 / NOVO-04] Remove tags meta refresh (prevenção de redirecionamento malicioso / phishing)
  // Itera sobre todas as tags meta com http-equiv normalizando espaços, controles e case
  const allHttpEquivMetas = doc.querySelectorAll('meta[http-equiv]');
  allHttpEquivMetas.forEach((m) => {
    const rawVal = m.getAttribute('http-equiv') || '';
    const normVal = rawVal.replace(/[\x00-\x20\s]/g, '').toLowerCase();
    if (normVal === 'refresh') {
      m.remove();
    }
  });

  // Remove CSP anterior
  const existingCsp = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]');
  existingCsp.forEach((m) => m.remove());

  if (injectCsp) {
    let head = doc.head;
    if (!head) {
      head = doc.createElement('head');
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    }
    const metaCsp = doc.createElement('meta');
    metaCsp.setAttribute('http-equiv', 'Content-Security-Policy');
    metaCsp.setAttribute('content', CSP_DIRECTIVE);
    head.insertBefore(metaCsp, head.firstChild);
  }

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
