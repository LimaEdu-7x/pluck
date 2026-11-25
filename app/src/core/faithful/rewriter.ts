import { safePath } from '../security/safe-path';
import { generateReplayShim } from './replay-shim';
import { isLocalhostPage, isPrivateIpOrHost } from '../security/url-guard';

export const BLOCKED_IMAGE_DATA =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const FAITHFUL_META_CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; object-src 'none'; connect-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:;";

export interface PathMapping {
  zipPath: string;      // Caminho dentro do ZIP (ex: 'index.html', '_external/cdn.exemplo.com/style.css')
  relativePath: string; // Caminho relativo a partir do arquivo que referencia
}

// Mapeia URL para caminho no ZIP, isolando CDNs em _external/<host>/
export function mapUrlToZipPath(urlStr: string, basePageUrl: string): string {
  try {
    const isBaseLocal = isLocalhostPage(basePageUrl);
    const url = new URL(urlStr, basePageUrl);
    const base = new URL(basePageUrl);

    // [FIEL-09] Bloqueia sub-recursos de loopback ou IPs privados quando a página base é remota
    if (!isBaseLocal && isPrivateIpOrHost(url.hostname, false)) {
      return '';
    }

    // Se a URL aponta para a raiz da página base
    if (url.origin === base.origin && (url.pathname === '/' || url.pathname === '')) {
      return 'index.html';
    }

    const isSameOrigin = url.origin === base.origin;
    let cleanPath = url.pathname.replace(/^\/+/, '');
    if (!cleanPath) cleanPath = 'index.html';

    // Se o pathname não tem extensão e é uma página/rota, adiciona .html ou index.html
    const hasExtension = /\.[a-zA-Z0-9]{1,8}$/.test(cleanPath);
    if (!hasExtension) {
      if (url.hostname.includes('typekit') || url.pathname.includes('/af/') || url.searchParams.has('fvd')) {
        cleanPath += '.woff2';
      } else {
        cleanPath += cleanPath.endsWith('/') ? 'index.html' : '.html';
      }
    }

    // Trata query string adicionando hash leve para evitar colisões
    if (url.search) {
      const qHash = Math.abs(hashCode(url.search)).toString(16).slice(0, 6);
      const extMatch = cleanPath.match(/(\.[a-zA-Z0-9]{1,8})$/);
      if (extMatch) {
        cleanPath = cleanPath.replace(extMatch[1], `.${qHash}${extMatch[1]}`);
      } else {
        cleanPath += `_${qHash}`;
      }
    }

    // Sanitiza cada segmento do caminho para ser seguro em Windows/Linux/Mac,
    // preservando pastas essenciais de frameworks como _next para manter compatibilidade com runtimes
    const segments = cleanPath.split('/').map((s) => {
      if (s === '_next' || s.startsWith('_next')) return s;
      return safePath(s);
    });
    const sanitizedRelative = segments.join('/');

    if (isSameOrigin) {
      return sanitizedRelative;
    } else {
      // Isola domínios externos em _external/<host>/
      const safeHost = safePath(url.hostname);
      return `_external/${safeHost}/${sanitizedRelative}`;
    }
  } catch {
    return `_external/misc/${safePath(urlStr)}`;
  }
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// Calcula caminho relativo seguro de um arquivo (fromZipPath) para outro (toZipPath)
export function getRelativePath(fromZipPath: string, toZipPath: string): string {
  const fromParts = fromZipPath.split('/');
  fromParts.pop(); // Remove o nome do arquivo atual para obter o diretório base

  const toParts = toZipPath.split('/');

  // Encontra prefixo comum
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const upCount = fromParts.length - common;
  const upStr = upCount > 0 ? '../'.repeat(upCount) : '';
  const remaining = toParts.slice(common).join('/');

  return (upStr + remaining) || './';
}

// Remove artefatos de reveal e fecha drawers/overlays de menu capturados abertos,
// permitindo que os scripts reinicializem de forma limpa sem cobrir o hero
export function dropDynamicRevealArtifacts(doc: Document): void {
  const staleReveals = doc.querySelectorAll(
    '.high-line-reveal, .item-reveal, .img-highlight-reveal, .rich-text-line-reveal, .cal-target-reveal'
  );
  for (let i = 0; i < staleReveals.length; i++) {
    staleReveals[i].remove();
  }

  // Garante que menus de navegação capturados em estado aberto comecem fechados (evita tela preta sobre o hero)
  const openMenus = doc.querySelectorAll('.nav-menu-w, [data-nav-m]');
  for (let i = 0; i < openMenus.length; i++) {
    const el = openMenus[i] as HTMLElement;
    if (el && el.style) {
      el.style.display = 'none';
      if (el.style.clipPath && el.style.clipPath.includes('100%')) {
        el.style.clipPath = 'ellipse(120% 0% at 50% 0%)';
      }
    }
  }
}

// Remove restrições de CDN (SRI e CORS) que impedem execução local
export function dropCdnGuards(doc: Document): void {
  const elements = doc.querySelectorAll('[integrity], [crossorigin]');
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    el.removeAttribute('integrity');
    el.removeAttribute('crossorigin');
  }
}

// Normaliza imagens para carregamento imediato offline e corrige srcset
export function normalizeImages(
  doc: Document,
  currentZipPath: string,
  urlToZipMap: Map<string, string>,
  pageUrl?: string
): void {
  const imgs = doc.querySelectorAll('img');
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];

    // Força loading eager para o browser decodificar todas as imagens offline
    if (img.getAttribute('loading') === 'lazy') {
      img.setAttribute('loading', 'eager');
    }

    // Corrige src de imagens (absolutas, protocol-relative ou root-relative)
    const src = img.getAttribute('src');
    if (src && !src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('#')) {
      let resolvedUrl = src;
      try {
        resolvedUrl = pageUrl ? new URL(src, pageUrl).href : src;
      } catch {}
      const cleanUrl = resolvedUrl.split('?')[0];
      const targetZip =
        urlToZipMap.get(resolvedUrl) ||
        urlToZipMap.get(src) ||
        urlToZipMap.get(cleanUrl);
      if (targetZip) {
        img.setAttribute('src', getRelativePath(currentZipPath, targetZip));
      } else if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
        img.setAttribute('src', BLOCKED_IMAGE_DATA);
      }
    }

    // Corrige srcset
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const parts = srcset.split(',');
      const rewrittenParts: string[] = [];
      let firstLocalRel = '';

      for (const part of parts) {
        const trimmed = part.trim();
        const firstSpace = trimmed.indexOf(' ');
        const urlCandidate = firstSpace > -1 ? trimmed.slice(0, firstSpace) : trimmed;
        const descriptor = firstSpace > -1 ? trimmed.slice(firstSpace) : '';

        // Tenta resolver no mapa
        let resolved = false;
        let candFull = urlCandidate;
        try { if (pageUrl) candFull = new URL(urlCandidate, pageUrl).href; } catch {}
        const cleanCand = candFull.split('?')[0];

        const targetZip =
          urlToZipMap.get(candFull) ||
          urlToZipMap.get(urlCandidate) ||
          urlToZipMap.get(cleanCand);

        if (targetZip) {
          const rel = getRelativePath(currentZipPath, targetZip);
          rewrittenParts.push(`${rel}${descriptor}`);
          if (!firstLocalRel) firstLocalRel = rel;
          resolved = true;
        } else {
          for (const [rawUrl, tz] of urlToZipMap.entries()) {
            if (
              rawUrl === candFull ||
              rawUrl === urlCandidate ||
              rawUrl.includes(urlCandidate) ||
              urlCandidate.includes(rawUrl)
            ) {
              const rel = getRelativePath(currentZipPath, tz);
              rewrittenParts.push(`${rel}${descriptor}`);
              if (!firstLocalRel) firstLocalRel = rel;
              resolved = true;
              break;
            }
          }
        }
        if (!resolved && !urlCandidate.startsWith('http://') && !urlCandidate.startsWith('https://') && !urlCandidate.startsWith('//')) {
          rewrittenParts.push(part);
        }
      }

      if (rewrittenParts.length > 0) {
        img.setAttribute('srcset', rewrittenParts.join(', '));
      } else if (firstLocalRel) {
        img.setAttribute('srcset', `${firstLocalRel} 1x`);
      } else {
        img.removeAttribute('srcset');
      }
    }
  }

  // Normaliza tags <source> em <picture>
  const sources = doc.querySelectorAll('source');
  for (let i = 0; i < sources.length; i++) {
    const srcEl = sources[i];
    const src = srcEl.getAttribute('src');
    if (src && !src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('#')) {
      let resolvedUrl = src;
      try { resolvedUrl = pageUrl ? new URL(src, pageUrl).href : src; } catch {}
      const cleanUrl = resolvedUrl.split('?')[0];
      const targetZip =
        urlToZipMap.get(resolvedUrl) ||
        urlToZipMap.get(src) ||
        urlToZipMap.get(cleanUrl);
      if (targetZip) {
        srcEl.setAttribute('src', getRelativePath(currentZipPath, targetZip));
      }
    }
    const srcset = srcEl.getAttribute('srcset');
    if (srcset) {
      const parts = srcset.split(',');
      const rewrittenParts: string[] = [];
      for (const part of parts) {
        const trimmed = part.trim();
        const spaceIdx = trimmed.indexOf(' ');
        const urlCandidate = spaceIdx > -1 ? trimmed.slice(0, spaceIdx) : trimmed;
        const descriptor = spaceIdx > -1 ? trimmed.slice(spaceIdx) : '';
        let resolved = false;
        let candFull = urlCandidate;
        try { if (pageUrl) candFull = new URL(urlCandidate, pageUrl).href; } catch {}
        const cleanCand = candFull.split('?')[0];

        const targetZip =
          urlToZipMap.get(candFull) ||
          urlToZipMap.get(urlCandidate) ||
          urlToZipMap.get(cleanCand);

        if (targetZip) {
          const rel = getRelativePath(currentZipPath, targetZip);
          rewrittenParts.push(`${rel}${descriptor}`);
          resolved = true;
        } else {
          for (const [rawUrl, tz] of urlToZipMap.entries()) {
            if (
              rawUrl === candFull ||
              rawUrl === urlCandidate ||
              rawUrl.includes(urlCandidate) ||
              urlCandidate.includes(rawUrl)
            ) {
              const rel = getRelativePath(currentZipPath, tz);
              rewrittenParts.push(`${rel}${descriptor}`);
              resolved = true;
              break;
            }
          }
        }
        if (!resolved && !urlCandidate.startsWith('http://') && !urlCandidate.startsWith('https://') && !urlCandidate.startsWith('//')) {
          rewrittenParts.push(part);
        }
      }
      if (rewrittenParts.length > 0) {
        srcEl.setAttribute('srcset', rewrittenParts.join(', '));
      }
    }
  }
}

// Higieniza formulários, campos de senha e dados sensíveis
export function sanitizeSensitiveFields(doc: Document): void {
  // Remove campos de senha
  const passwords = doc.querySelectorAll('input[type="password"]');
  for (let i = 0; i < passwords.length; i++) {
    passwords[i].remove();
  }

  // Limpa tokens e nonces em inputs ocultos
  const hiddens = doc.querySelectorAll('input[type="hidden"]');
  const sensitiveNames = /csrf|token|nonce|authenticity|auth_token|session/i;
  for (let i = 0; i < hiddens.length; i++) {
    const h = hiddens[i];
    const name = h.getAttribute('name') || h.getAttribute('id') || '';
    if (sensitiveNames.test(name)) {
      h.setAttribute('value', '');
    }
  }

  // Remove actions ativas de formulários
  const forms = doc.querySelectorAll('form');
  for (let i = 0; i < forms.length; i++) {
    forms[i].removeAttribute('action');
    forms[i].setAttribute('onsubmit', 'return false;');
  }
}

// Injeta Meta CSP que bloqueia rede externa mas permite scripts e workers locais do framework
export function injectFaithfulCsp(doc: Document): void {
  // Remove CSPs existentes para não conflitar
  const existingCsps = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
  for (let i = 0; i < existingCsps.length; i++) {
    existingCsps[i].remove();
  }

  let head = doc.head;
  if (!head) {
    head = doc.createElement('head');
    if (doc.documentElement.firstChild) {
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    } else {
      doc.documentElement.appendChild(head);
    }
  }

  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', FAITHFUL_META_CSP);

  if (head.firstChild) {
    head.insertBefore(meta, head.firstChild);
  } else {
    head.appendChild(meta);
  }
}

// Injeta interceptor/shim local de replay para redirecionar chamadas assíncronas dinâmicas a recursos locais
export function injectFetchInterceptor(
  doc: Document,
  currentZipPath: string,
  urlToZipMap: Map<string, string>
): void {
  const mapObj: Record<string, string> = {};
  for (const [origUrl, targetZip] of urlToZipMap.entries()) {
    if (origUrl.startsWith('data:') || origUrl.startsWith('blob:')) continue;
    const rel = getRelativePath(currentZipPath, targetZip);
    mapObj[origUrl] = rel;
    const clean = origUrl.split('?')[0];
    if (clean !== origUrl && !mapObj[clean]) {
      mapObj[clean] = rel;
    }
  }

  let head = doc.head;
  if (!head) {
    head = doc.createElement('head');
    doc.documentElement.appendChild(head);
  }

  const script = doc.createElement('script');
  script.id = '__pluck_replay_shim__';
  script.textContent = generateReplayShim(mapObj);

  if (head.firstChild) {
    head.insertBefore(script, head.firstChild.nextSibling || head.firstChild);
  } else {
    head.appendChild(script);
  }
}

// Reescritor principal de documento HTML
export function rewriteHtmlDocument(
  html: string,
  pageUrl: string,
  currentZipPath: string,
  urlToZipMap: Map<string, string>,
  isSinglePageScope = false
): string {
  // Protege contra bug do parser do happy-dom onde tags <style> aninhadas em <svg> fecham prematuramente o body
  const svgStyleStore: string[] = [];
  const sanitizedHtml = html.replace(/(<svg\b[^>]*>[\s\S]*?)<style\b[^>]*>([\s\S]*?)<\/style>([\s\S]*?<\/svg>)/gi, (_m, before, css, after) => {
    const placeholder = `__pluck_svg_style_${svgStyleStore.length}__`;
    svgStyleStore.push(css);
    return `${before}<!--${placeholder}-->${after}`;
  });

  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizedHtml, 'text/html');

  dropCdnGuards(doc);
  dropDynamicRevealArtifacts(doc);
  normalizeImages(doc, currentZipPath, urlToZipMap, pageUrl);
  sanitizeSensitiveFields(doc);
  injectFaithfulCsp(doc);
  injectFetchInterceptor(doc, currentZipPath, urlToZipMap);

  // [FIEL-08] Remove tags de pré-resolução DNS que vazam consultas externas
  const dnsLinks = doc.querySelectorAll('link[rel="dns-prefetch"], link[rel="preconnect"]');
  for (let i = 0; i < dnsLinks.length; i++) {
    dnsLinks[i].remove();
  }

  // Reescreve <link rel="stylesheet">, <link rel="icon">, etc.
  const links = doc.querySelectorAll('link[href]');
  for (let i = 0; i < links.length; i++) {
    const el = links[i];
    const href = el.getAttribute('href');
    if (!href) continue;
    try {
      const resolvedUrl = new URL(href, pageUrl).href;
      const cleanUrl = resolvedUrl.split('?')[0];
      const targetZip =
        urlToZipMap.get(resolvedUrl) ||
        urlToZipMap.get(href) ||
        urlToZipMap.get(cleanUrl);
      if (targetZip) {
        const rel = targetZip.startsWith('_next/') ? '/' + targetZip : getRelativePath(currentZipPath, targetZip);
        el.setAttribute('href', rel);
      } else if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('icon')) {
          el.setAttribute('href', BLOCKED_IMAGE_DATA);
        }
      }
    } catch {}
  }

  // Reescreve <script src="..."> e remove trackers
  const scripts = doc.querySelectorAll('script[src]');
  for (let i = 0; i < scripts.length; i++) {
    const el = scripts[i];
    const src = el.getAttribute('src');
    if (!src) continue;
    if (
      src.includes('googletagmanager.com') ||
      src.includes('google-analytics.com') ||
      src.includes('google_tags_first_party') ||
      src.includes('klaviyo') ||
      src.includes('gorgias') ||
      src.includes('9gtb') ||
      src.includes('purpledot') ||
      src.includes('perf-kit') ||
      src.includes('preloads') ||
      src.includes('shop-js') ||
      src.includes('cart-sync') ||
      src.includes('load_feature') ||
      src.includes('origin_trials') ||
      src.includes('shopify_pay') ||
      src.includes('privacy-banner') ||
      src.includes('hotjar') ||
      src.includes('fbevents') ||
      src.includes('facebook') ||
      src.includes('doubleclick') ||
      src.includes('clarity.ms') ||
      src.includes('segment.io') ||
      src.includes('shop.app/checkouts') ||
      src.includes('shopifycloud/checkout-web') ||
      src.includes('shopifycloud/perf-kit') ||
      src.includes('shopifycloud/shop-js') ||
      src.includes('shopifycloud/privacy-banner') ||
      src.includes('shopifycloud/storefront/assets/storefront/load_feature') ||
      src.includes('shopifycloud/storefront/assets/shopify_pay') ||
      src.includes('shopifycloud/storefront/assets/storefront/origin_trials') ||
      src.includes('avljl2rk9q5p') ||
      src.includes('/ga/g/c')
    ) {
      el.remove();
      continue;
    }
    try {
      const resolvedUrl = new URL(src, pageUrl).href;
      const cleanUrl = resolvedUrl.split('?')[0];
      const cleanSrc = src.split('?')[0];
      let targetZip =
        urlToZipMap.get(resolvedUrl) ||
        urlToZipMap.get(src) ||
        urlToZipMap.get(cleanUrl) ||
        urlToZipMap.get(cleanSrc);

      if (!targetZip) {
        const filename = cleanUrl.split('/').pop();
        if (filename && filename.includes('.')) {
          for (const [k, v] of urlToZipMap.entries()) {
            if (k.endsWith('/' + filename) || k.split('?')[0].endsWith('/' + filename)) {
              targetZip = v;
              break;
            }
          }
        }
      }

      if (targetZip) {
        const rel = targetZip.startsWith('_next/') ? '/' + targetZip : getRelativePath(currentZipPath, targetZip);
        el.setAttribute('src', rel);
      } else if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
        el.setAttribute('type', 'application/blocked');
        el.removeAttribute('src');
      }
    } catch {}
  }

  // Remove scripts inline de telemetria/rastreamento (preservando o replay shim)
  const allScripts = doc.querySelectorAll('script');
  for (let i = 0; i < allScripts.length; i++) {
    const s = allScripts[i];
    if (s.id === '__pluck_replay_shim__' || s.textContent?.includes('URL_MAP')) continue;
    const text = s.textContent || '';
    if (
      text.includes('google_tags_first_party') ||
      text.includes("gtag('config'") ||
      text.includes('gtag("config"') ||
      text.includes('gtag(') ||
      text.includes('wpmLoader') ||
      text.includes('__TREKKIE_SHIM_QUEUE') ||
      text.includes('ShopifyAnalytics') ||
      text.includes('klaviyo') ||
      text.includes('PurpleDotConfig') ||
      text.includes('h.hj = h.hj') ||
      text.includes('h, o, t, j, a, r') ||
      text.includes('loader.init-shop-cart-sync') ||
      text.includes('Shopify.SignInWithShop') ||
      text.includes('ShopifyPay') ||
      text.includes('portableWalletsFindBuyerConsent') ||
      text.includes('Shopify.PaymentButton') ||
      text.includes('webmcp') ||
      text.includes('customDocumentWrite') ||
      text.includes('initGorgiasChatPromise')
    ) {
      s.remove();
    }
  }

  // Fallback de visibilidade para seletores de moeda usando Choices.js (ex: loja Shopify)
  const currencySelects = doc.querySelectorAll('.currency-selector select[data-choices]');
  if (currencySelects.length > 0 && doc.head) {
    const currencyStyle = doc.createElement('style');
    currencyStyle.textContent = `
      .currency-selector select[data-choices] {
        opacity: 1 !important;
        display: inline-block !important;
        appearance: none;
        -webkit-appearance: none;
        background: transparent !important;
        background-color: transparent !important;
        color: var(--header-color-font, #d2ff00) !important;
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
        font-family: inherit;
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
        padding-right: 14px;
      }
      .currency-selector .choices {
        display: flex !important;
      }
    `;
    doc.head.appendChild(currencyStyle);
  }

  // Reescreve URLs dentro de tags <style> inline
  const inlineStyles = doc.querySelectorAll('style');
  for (let i = 0; i < inlineStyles.length; i++) {
    const s = inlineStyles[i];
    if (s.textContent) {
      s.textContent = rewriteCssContent(s.textContent, pageUrl, currentZipPath, urlToZipMap);
    }
  }

  // Reescreve atributos style inline em qualquer elemento que contenha url(...)
  const elementsWithStyle = doc.querySelectorAll('[style]');
  for (let i = 0; i < elementsWithStyle.length; i++) {
    const el = elementsWithStyle[i];
    const styleAttr = el.getAttribute('style');
    if (styleAttr && /url\(/i.test(styleAttr)) {
      el.setAttribute('style', rewriteCssContent(styleAttr, pageUrl, currentZipPath, urlToZipMap));
    }
  }

  // Limpa canvas Three.js estáticos pré-existentes de .gl-wrap para evitar colisão/deslocamento
  const glWraps = doc.querySelectorAll('.gl-wrap');
  for (let i = 0; i < glWraps.length; i++) {
    glWraps[i].innerHTML = '';
  }

  // Reescreve <img>, <video>, <audio>, <source>
  const mediaElements = doc.querySelectorAll('img[src], video[src], audio[src], source[src]');
  for (let i = 0; i < mediaElements.length; i++) {
    const el = mediaElements[i];
    const src = el.getAttribute('src');
    if (!src) continue;
    try {
      const resolvedUrl = new URL(src, pageUrl).href;
      const cleanUrl = resolvedUrl.split('?')[0];
      const targetZip =
        urlToZipMap.get(resolvedUrl) ||
        urlToZipMap.get(src) ||
        urlToZipMap.get(cleanUrl);
      if (targetZip) {
        el.setAttribute('src', getRelativePath(currentZipPath, targetZip));
      } else if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
        el.setAttribute('src', BLOCKED_IMAGE_DATA);
      }
    } catch {}
  }

  // Reescreve links <a href="..."> para páginas baixadas ou fallback amigável
  const anchors = doc.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const resolvedUrl = new URL(href, pageUrl).href;
      const cleanUrl = resolvedUrl.split('?')[0];
      const targetZip =
        urlToZipMap.get(resolvedUrl) ||
        urlToZipMap.get(href) ||
        urlToZipMap.get(cleanUrl);
      if (targetZip && targetZip.endsWith('.html')) {
        a.setAttribute('href', getRelativePath(currentZipPath, targetZip));
      } else {
        const u = new URL(resolvedUrl);
        const b = new URL(pageUrl);
        if (isSinglePageScope && u.origin === b.origin && u.pathname !== b.pathname) {
          // Subpágina interna não capturada no modo 'Esta página': direciona para offline-fallback.html
          a.setAttribute('href', getRelativePath(currentZipPath, 'offline-fallback.html'));
          a.setAttribute('data-pluck-uncaptured', 'true');
          a.setAttribute('title', 'Página não capturada neste pacote (Modo Esta página)');
        } else if (u.origin !== b.origin) {
          // Link para domínio externo não confirmado/capturado: direciona para offline-fallback.html (nunca tela branca)
          a.setAttribute('href', getRelativePath(currentZipPath, 'offline-fallback.html'));
          a.setAttribute('data-pluck-uncaptured', 'true');
          a.setAttribute('title', `Domínio externo não incluído (${u.hostname})`);
        }
      }
    } catch {}
  }

  let outputHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  for (let i = 0; i < svgStyleStore.length; i++) {
    outputHtml = outputHtml.replace(`<!--__pluck_svg_style_${i}__-->`, `<style>${svgStyleStore[i]}</style>`);
  }

  return outputHtml;
}

// Reescritor de URLs dentro de arquivos CSS (@import e url(...))
export function rewriteCssContent(
  cssText: string,
  cssUrl: string,
  currentZipPath: string,
  urlToZipMap: Map<string, string>
): string {
  return cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, urlValue) => {
    if (!urlValue || urlValue.startsWith('data:') || urlValue.startsWith('#') || urlValue.startsWith('blob:')) {
      return match;
    }
    try {
      const resolved = new URL(urlValue, cssUrl).href;
      const cleanResolved = resolved.split('?')[0].split('#')[0];
      const decodedResolved = decodeURIComponent(resolved);
      const decodedClean = decodeURIComponent(cleanResolved);

      let targetZip =
        urlToZipMap.get(resolved) ||
        urlToZipMap.get(urlValue) ||
        urlToZipMap.get(cleanResolved) ||
        urlToZipMap.get(decodedResolved) ||
        urlToZipMap.get(decodedClean);

      if (!targetZip) {
        const filename = cleanResolved.split('/').pop();
        if (filename && filename.includes('.')) {
          for (const [k, v] of urlToZipMap.entries()) {
            if (k.endsWith('/' + filename) || k.split('?')[0].endsWith('/' + filename)) {
              targetZip = v;
              break;
            }
          }
        }
      }

      if (targetZip) {
        const rel = getRelativePath(currentZipPath, targetZip);
        return `url(${quote}${rel}${quote})`;
      } else if (
        cleanResolved.endsWith('.svg') ||
        cleanResolved.endsWith('.png') ||
        cleanResolved.endsWith('.jpg') ||
        cleanResolved.endsWith('.jpeg') ||
        cleanResolved.endsWith('.gif') ||
        cleanResolved.endsWith('.webp')
      ) {
        return `url(${quote}${BLOCKED_IMAGE_DATA}${quote})`;
      }
    } catch {}
    return match;
  });
}

// Reescritor de URLs estáticas dentro de arquivos JavaScript (preserva integridade de sintaxe/construtores)
export function rewriteJsContent(
  jsText: string,
  _currentZipPath: string,
  _urlToZipMap: Map<string, string>
): string {
  // Bundles JavaScript modernos (Next.js, Webpack, Turbopack, Vite) utilizam construtores nativos
  // como new URL(url) e sistemas de carregamento de chunks internos que quebram com TypeError
  // quando URLs absolutas são substituídas cegamente por caminhos relativos (ex: ../../../_external/...).
  // A interceptação dinâmica de rede (fetch, XHR, Image, Scripts) é assegurada de forma transparente
  // pelo replay-shim.ts através do URL_MAP.
  return jsText;
}
