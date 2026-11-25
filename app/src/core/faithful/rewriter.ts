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

    // Se o pathname não tem extensão e é uma página interna, adiciona .html
    const hasExtension = /\.[a-zA-Z0-9]{1,8}$/.test(cleanPath);
    if (!hasExtension && isSameOrigin) {
      cleanPath += cleanPath.endsWith('/') ? 'index.html' : '.html';
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

    // Sanitiza cada segmento do caminho para ser seguro em Windows/Linux/Mac
    const segments = cleanPath.split('/').map((s) => safePath(s));
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

    // Corrige src de imagens externas não mapeadas para não estourar CSP
    const src = img.getAttribute('src');
    if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//'))) {
      let resolvedUrl = src;
      try {
        resolvedUrl = pageUrl ? new URL(src, pageUrl).href : src;
      } catch {}
      const targetZip = urlToZipMap.get(resolvedUrl) || urlToZipMap.get(src);
      if (targetZip) {
        img.setAttribute('src', getRelativePath(currentZipPath, targetZip));
      } else {
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
        for (const [rawUrl, targetZip] of urlToZipMap.entries()) {
          if (rawUrl.includes(urlCandidate) || urlCandidate.includes(rawUrl)) {
            const rel = getRelativePath(currentZipPath, targetZip);
            rewrittenParts.push(`${rel}${descriptor}`);
            if (!firstLocalRel) firstLocalRel = rel;
            resolved = true;
            break;
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
  urlToZipMap: Map<string, string>
): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  dropCdnGuards(doc);
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
      const targetZip = urlToZipMap.get(resolvedUrl) || urlToZipMap.get(href);
      if (targetZip) {
        el.setAttribute('href', getRelativePath(currentZipPath, targetZip));
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
      src.includes('avljl2rk9q5p') ||
      src.includes('/ga/g/c')
    ) {
      el.remove();
      continue;
    }
    try {
      const resolvedUrl = new URL(src, pageUrl).href;
      const targetZip = urlToZipMap.get(resolvedUrl) || urlToZipMap.get(src);
      if (targetZip) {
        el.setAttribute('src', getRelativePath(currentZipPath, targetZip));
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
    if (text.includes('google_tags_first_party') || text.includes("gtag('config'") || text.includes('gtag("config"')) {
      s.remove();
    }
  }

  // Reescreve URLs dentro de tags <style> inline
  const inlineStyles = doc.querySelectorAll('style');
  for (let i = 0; i < inlineStyles.length; i++) {
    const s = inlineStyles[i];
    if (s.textContent) {
      s.textContent = rewriteCssContent(s.textContent, pageUrl, currentZipPath, urlToZipMap);
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
      const targetZip = urlToZipMap.get(resolvedUrl) || urlToZipMap.get(src);
      if (targetZip) {
        el.setAttribute('src', getRelativePath(currentZipPath, targetZip));
      } else if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
        el.setAttribute('src', BLOCKED_IMAGE_DATA);
      }
    } catch {}
  }

  // Reescreve links internos <a href="..."> para páginas baixadas
  const anchors = doc.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    try {
      const resolvedUrl = new URL(href, pageUrl).href;
      const targetZip = urlToZipMap.get(resolvedUrl) || urlToZipMap.get(href);
      if (targetZip && targetZip.endsWith('.html')) {
        a.setAttribute('href', getRelativePath(currentZipPath, targetZip));
      }
    } catch {}
  }

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

// Reescritor de URLs dentro de arquivos CSS (@import e url(...))
export function rewriteCssContent(
  cssText: string,
  cssUrl: string,
  currentZipPath: string,
  urlToZipMap: Map<string, string>
): string {
  return cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, urlValue) => {
    if (!urlValue || urlValue.startsWith('data:') || urlValue.startsWith('#')) {
      return match;
    }
    try {
      const resolved = new URL(urlValue, cssUrl).href;
      const targetZip = urlToZipMap.get(resolved) || urlToZipMap.get(urlValue);
      if (targetZip) {
        const rel = getRelativePath(currentZipPath, targetZip);
        return `url(${quote}${rel}${quote})`;
      }
    } catch {}
    return match;
  });
}

// Reescritor de URLs estáticas dentro de arquivos JavaScript (ex: CDNs hardcoded em bundles)
export function rewriteJsContent(
  jsText: string,
  currentZipPath: string,
  urlToZipMap: Map<string, string>
): string {
  let rewritten = jsText;
  for (const [origUrl, targetZip] of urlToZipMap.entries()) {
    if (origUrl.length < 8 || origUrl.startsWith('data:') || origUrl.startsWith('blob:')) continue;
    if (rewritten.includes(origUrl)) {
      const rel = getRelativePath(currentZipPath, targetZip);
      rewritten = rewritten.replaceAll(origUrl, rel);
    }
  }
  return rewritten;
}
