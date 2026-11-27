// Serializador de DOM Vivo com suporte a Web Components (Shadow DOM Declarativo) e Lazy-Loading

export interface DomSerializerOptions {
  includeDeclarativeShadowDom?: boolean;
  resolveLazyImages?: boolean;
  forceEagerImages?: boolean;
}

/**
 * Detecta se uma página é uma SPA pesada (ex: YouTube, Twitter/X) cujos scripts de cliente
 * tentam reidratar, dependem de conexões RPC e quebram no modo offline.
 * Nesses casos, o motor desliga os scripts de aplicação e mantém o DOM serializado estático
 * mais todo o CSS intacto (modo foto fiel).
 */
export function isHeavySpa(url: string | null | undefined, html?: string | null): boolean {
  if (url) {
    const lowerUrl = url.toLowerCase();
    if (
      lowerUrl.includes('youtube.com') ||
      lowerUrl.includes('youtu.be') ||
      lowerUrl.includes('twitter.com') ||
      lowerUrl.includes('x.com')
    ) {
      return true;
    }
  }
  if (html && typeof html === 'string') {
    const lowerHtml = html.toLowerCase();
    if (
      lowerHtml.includes('ytd-app') ||
      lowerHtml.includes('ytd-rich-item-renderer') ||
      lowerHtml.includes('ytd-video-renderer') ||
      lowerHtml.includes('yt-page-navigation-progress')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detecta se um documento HTML é apenas um esqueleto (skeleton shell) não hidratado de uma SPA
 * (ex: YouTube, Twitter) que ainda não carregou os cards/conteúdos reais.
 */
export function isSpaSkeleton(html: string | null | undefined): boolean {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();

  // YouTube skeleton detectado
  if (
    lower.includes('id="skeleton"') ||
    lower.includes('class="skeleton-bg-color') ||
    (lower.includes('ytd-app') && !lower.includes('ytd-rich-item-renderer') && !lower.includes('ytd-video-renderer'))
  ) {
    return true;
  }

  // Shell genérico de SPA com root vazio
  if (
    (lower.includes('id="root"></div>') || lower.includes('id="app"></div>') || lower.includes('id="__next"></div>')) &&
    !lower.includes('<article') &&
    !lower.includes('<main')
  ) {
    return true;
  }

  return false;
}

/**
 * Serializa um nó do DOM preservando Shadow Roots abertos (via <template shadowrootmode="open">)
 * e resolvendo atributos de imagens lazy-loaded (como thumbnails do YouTube).
 *
 * NOTA DE ARQUITETURA: Esta função é 100% autocontida (todas as funções auxiliares estão dentro
 * do seu escopo). Isso permite que ela seja serializada via .toString() e executada sem falhas
 * de referência via chrome.scripting.executeScript({ func: serializeLiveDom }) ou CDP Runtime.evaluate.
 */
export function serializeLiveDom(
  root?: Node | null,
  options?: DomSerializerOptions
): string {
  const targetRoot: Node | null =
    root !== undefined && root !== null
      ? root
      : typeof document !== 'undefined'
      ? document.documentElement
      : null;

  if (!targetRoot) return '';

  const opts = options || {};
  const includeShadow = opts.includeDeclarativeShadowDom !== false;
  const resolveLazy = opts.resolveLazyImages !== false;
  const forceEager = opts.forceEagerImages !== false;

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttribute(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  }

  function serializeNode(node: Node): string {
    switch (node.nodeType) {
      case Node.TEXT_NODE:
        return escapeHtml(node.nodeValue || '');

      case Node.COMMENT_NODE:
        return `<!--${node.nodeValue || ''}-->`;

      case Node.ELEMENT_NODE: {
        const el = node as HTMLElement;
        const tagName = el.tagName.toLowerCase();

        // Monta tag de abertura e atributos
        let output = `<${tagName}`;

        // Se for imagem, resolve src ativo de lazy-load (ex: YouTube yt-img-shadow / ytCoreImage)
        let resolvedSrc: string | null = null;
        if (tagName === 'img' && resolveLazy) {
          const img = el as HTMLImageElement;
          resolvedSrc =
            img.currentSrc ||
            img.getAttribute('src') ||
            img.getAttribute('data-thumb') ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-original') ||
            null;

          // Fallback específico para YouTube: se o src estiver vazio ou for placeholder transparente 1x1,
          // tenta inferir o thumbnail a partir do link do vídeo pai mais próximo
          if (
            !resolvedSrc ||
            resolvedSrc === 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' ||
            resolvedSrc.trim() === ''
          ) {
            try {
              const container = el.closest(
                'ytd-thumbnail, ytd-playlist-thumbnail, ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer'
              );
              if (container) {
                const anchor = container.querySelector('a[href*="watch?v="], a[href*="/shorts/"]');
                const href = anchor ? anchor.getAttribute('href') || '' : '';
                const vMatch =
                  href.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
                if (vMatch && vMatch[1]) {
                  resolvedSrc = `https://i.ytimg.com/vi/${vMatch[1]}/hqdefault.jpg`;
                }
              }
            } catch {}
          }
        }

        for (let i = 0; i < el.attributes.length; i++) {
          const attr = el.attributes[i];
          let val = attr.value;

          if (tagName === 'img') {
            if (attr.name === 'src' && resolvedSrc) {
              val = resolvedSrc;
            }
            if (attr.name === 'loading' && forceEager) {
              val = 'eager';
            }
          }

          output += ` ${attr.name}="${escapeAttribute(val)}"`;
        }

        // Se for img e não tinha atributo src mas conseguimos resolver
        if (tagName === 'img' && resolvedSrc && !el.hasAttribute('src')) {
          output += ` src="${escapeAttribute(resolvedSrc)}"`;
        }
        if (tagName === 'img' && forceEager && !el.hasAttribute('loading')) {
          output += ` loading="eager"`;
        }

        output += '>';

        // Tags void (sem fechamento)
        const voidTags = new Set([
          'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
          'link', 'meta', 'param', 'source', 'track', 'wbr'
        ]);
        if (voidTags.has(tagName)) {
          return output;
        }

        // Se o elemento possui ShadowRoot aberto, serializa como Declarative Shadow DOM
        if (includeShadow && (el as any).shadowRoot) {
          const shadow = (el as any).shadowRoot as ShadowRoot;
          output += '<template shadowrootmode="open" shadowroot="open">';
          for (let i = 0; i < shadow.childNodes.length; i++) {
            output += serializeNode(shadow.childNodes[i]);
          }
          output += '</template>';
        }

        // Se for tag <template>, serializa os nós do .content DocumentFragment se existir
        if (tagName === 'template' && (el as HTMLTemplateElement).content) {
          const content = (el as HTMLTemplateElement).content;
          for (let i = 0; i < content.childNodes.length; i++) {
            output += serializeNode(content.childNodes[i]);
          }
        } else {
          // Filhos normais do Light DOM
          for (let i = 0; i < el.childNodes.length; i++) {
            output += serializeNode(el.childNodes[i]);
          }
        }

        output += `</${tagName}>`;
        return output;
      }

      case Node.DOCUMENT_FRAGMENT_NODE: {
        let fragOutput = '';
        for (let i = 0; i < node.childNodes.length; i++) {
          fragOutput += serializeNode(node.childNodes[i]);
        }
        return fragOutput;
      }

      default:
        return '';
    }
  }

  // Se o nó for Document, preserva DOCTYPE se existir
  if (targetRoot.nodeType === Node.DOCUMENT_NODE) {
    const doc = targetRoot as Document;
    const parts: string[] = [];
    if (doc.doctype) {
      parts.push(`<!DOCTYPE ${doc.doctype.name}>`);
    }
    if (doc.documentElement) {
      parts.push(serializeNode(doc.documentElement));
    }
    return parts.join('\n');
  }

  // Documento vivo: carimba a origem real (só a origem) para o motor recusar DOM lido de outro site
  const stamp =
    root === undefined || root === null
      ? `<!--pluck-source-origin:${typeof location !== 'undefined' ? location.origin : ''}-->`
      : '';
  return serializeNode(targetRoot) + stamp;
}
