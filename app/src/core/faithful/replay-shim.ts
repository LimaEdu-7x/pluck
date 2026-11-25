// Shim de Replay de Arquivos Web do Pluck
// Intercepta e remapeia todas as chamadas dinâmicas (fetch, XHR, Image, Media, CSS, Worker, WASM)
// Bloqueia qualquer URL externa não presente no mapa para nunca tocar a rede externa (0 violações de CSP).

export function escapeJsonForScript(jsonStr: string): string {
  return jsonStr
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function generateReplayShim(urlMap: Record<string, string>): string {
  // Serializa o mapa com segurança (FIEL-02)
  const serializedMap = escapeJsonForScript(JSON.stringify(urlMap || {}));

  return `(function() {
  'use strict';
  const URL_MAP = ${serializedMap};

  // Stubs globais para telemetria/analytics para evitar erros em runtime
  try {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function() {};
    window.ga = window.ga || function() {};
  } catch {}

  function resolveUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    const urlStr = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
    if (!urlStr) return rawUrl;
    // Permite data: e blob: locais sem alteração
    if (urlStr.startsWith('data:') || urlStr.startsWith('blob:')) return urlStr;

    // Se for URL de telemetria / analytics / beacons conhecidos, bloqueia imediatamente
    if (
      /googletagmanager\\.com|google-analytics\\.com|doubleclick\\.net|hotjar\\.com|segment\\.io|clarity\\.ms/i.test(urlStr) ||
      /\\/ga\\/g\\/c|\\/_gsid|\\/api\\/track|\\/collect|google_tags_first_party/i.test(urlStr)
    ) {
      return null;
    }

    // Se já é relativo ou aponta para localhost / 127.0.0.1, permite
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://') && !urlStr.startsWith('//')) {
      return urlStr;
    }

    let fullUrl = urlStr;
    if (urlStr.startsWith('//')) {
      fullUrl = window.location.protocol + urlStr;
    }

    try {
      const parsed = new URL(fullUrl, window.location.href);
      // Mesma origem local (127.0.0.1 / localhost)
      if (parsed.origin === window.location.origin) {
        return rawUrl;
      }

      // 1. Procura URL exata no mapa
      if (URL_MAP[fullUrl]) return URL_MAP[fullUrl];

      // 2. Procura URL sem query string e sem hash
      const cleanUrl = parsed.origin + parsed.pathname;
      if (URL_MAP[cleanUrl]) return URL_MAP[cleanUrl];

      // 3. Procura por sufixo de caminho / nome de arquivo
      const filename = parsed.pathname.split('/').pop();
      if (filename) {
        for (const [k, v] of Object.entries(URL_MAP)) {
          if (k.endsWith('/' + filename)) {
            return v;
          }
        }
      }

      // 4. Bloqueia qualquer recurso externo que não esteja no mapa
      console.warn('[Pluck Replay] Bloqueado recurso externo não mapeado:', fullUrl);
      return null;
    } catch {
      return rawUrl;
    }
  }

  const BLOCKED_IMAGE_DATA = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const BLOCKED_AUDIO_DATA = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  const BLOCKED_SCRIPT_DATA = 'data:application/javascript;charset=utf-8,/*blocked*/';

  function rewriteSrcset(srcsetStr) {
    if (!srcsetStr || typeof srcsetStr !== 'string') return srcsetStr;
    const parts = srcsetStr.split(',');
    const rewritten = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      const urlPart = spaceIdx > -1 ? trimmed.slice(0, spaceIdx) : trimmed;
      const descriptor = spaceIdx > -1 ? trimmed.slice(spaceIdx) : '';
      const resolved = resolveUrl(urlPart);
      if (resolved !== null) {
        rewritten.push((resolved || urlPart) + descriptor);
      }
    }
    return rewritten.length > 0 ? rewritten.join(', ') : BLOCKED_IMAGE_DATA + ' 1x';
  }

  function rewriteCssUrls(cssText) {
    if (!cssText || typeof cssText !== 'string' || !cssText.includes('url(')) return cssText;
    return cssText.replace(/url\\(\\s*(['"]?)(.*?)\\1\\s*\\)/gi, (match, quote, urlValue) => {
      if (!urlValue || urlValue.startsWith('data:') || urlValue.startsWith('blob:') || urlValue.startsWith('#')) {
        return match;
      }
      const resolved = resolveUrl(urlValue);
      if (resolved === null) {
        return \`url(\${quote}\${BLOCKED_IMAGE_DATA}\${quote})\`;
      }
      return \`url(\${quote}\${resolved}\${quote})\`;
    });
  }

  // 1. Intercepta fetch
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    let rawUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    const resolved = resolveUrl(rawUrl);
    if (resolved === null) {
      return Promise.resolve(new Response(new Blob([]), { status: 200, statusText: 'Blocked by Pluck' }));
    }
    if (resolved && resolved !== rawUrl) {
      if (typeof input === 'string') {
        input = resolved;
      } else {
        input = new Request(resolved, input);
      }
    }
    return origFetch.call(this, input, init);
  };

  // 2. Intercepta XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const resolved = resolveUrl(url);
    if (resolved === null) {
      this.__pluckBlocked = true;
      return origOpen.call(this, method, 'data:text/plain;charset=utf-8,', ...rest);
    }
    return origOpen.call(this, method, resolved || url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (this.__pluckBlocked) {
      setTimeout(() => {
        try {
          Object.defineProperty(this, 'status', { value: 200, configurable: true });
          Object.defineProperty(this, 'responseText', { value: '', configurable: true });
          Object.defineProperty(this, 'response', { value: '', configurable: true });
          if (typeof this.onreadystatechange === 'function') {
            Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
            this.onreadystatechange(new Event('readystatechange'));
          }
          if (typeof this.onload === 'function') this.onload(new ProgressEvent('load'));
          if (typeof this.onloadend === 'function') this.onloadend(new ProgressEvent('loadend'));
        } catch {}
      }, 0);
      return;
    }
    return origSend.apply(this, args);
  };

  // 3. Intercepta HTMLImageElement (new Image() e <img src/srcset>)
  const imgProto = HTMLImageElement.prototype;
  const origImgSrcDesc = Object.getOwnPropertyDescriptor(imgProto, 'src');
  if (origImgSrcDesc && origImgSrcDesc.set) {
    Object.defineProperty(imgProto, 'src', {
      get: function() { return origImgSrcDesc.get.call(this); },
      set: function(val) {
        const resolved = resolveUrl(val);
        const finalVal = resolved === null ? BLOCKED_IMAGE_DATA : (resolved || val);
        return origImgSrcDesc.set.call(this, finalVal);
      },
      configurable: true,
      enumerable: true
    });
  }

  const origImgSrcsetDesc = Object.getOwnPropertyDescriptor(imgProto, 'srcset');
  if (origImgSrcsetDesc && origImgSrcsetDesc.set) {
    Object.defineProperty(imgProto, 'srcset', {
      get: function() { return origImgSrcsetDesc.get.call(this); },
      set: function(val) {
        return origImgSrcsetDesc.set.call(this, rewriteSrcset(val));
      },
      configurable: true,
      enumerable: true
    });
  }

  // 4. Intercepta HTMLSourceElement
  const srcProto = HTMLSourceElement.prototype;
  const origSourceSrcDesc = Object.getOwnPropertyDescriptor(srcProto, 'src');
  if (origSourceSrcDesc && origSourceSrcDesc.set) {
    Object.defineProperty(srcProto, 'src', {
      get: function() { return origSourceSrcDesc.get.call(this); },
      set: function(val) {
        const resolved = resolveUrl(val);
        return origSourceSrcDesc.set.call(this, resolved === null ? BLOCKED_IMAGE_DATA : (resolved || val));
      },
      configurable: true,
      enumerable: true
    });
  }

  const origSourceSrcsetDesc = Object.getOwnPropertyDescriptor(srcProto, 'srcset');
  if (origSourceSrcsetDesc && origSourceSrcsetDesc.set) {
    Object.defineProperty(srcProto, 'srcset', {
      get: function() { return origSourceSrcsetDesc.get.call(this); },
      set: function(val) {
        return origSourceSrcsetDesc.set.call(this, rewriteSrcset(val));
      },
      configurable: true,
      enumerable: true
    });
  }

  // 5. Intercepta HTMLMediaElement (Audio/Video)
  const mediaProto = HTMLMediaElement.prototype;
  const origMediaSrcDesc = Object.getOwnPropertyDescriptor(mediaProto, 'src');
  if (origMediaSrcDesc && origMediaSrcDesc.set) {
    Object.defineProperty(mediaProto, 'src', {
      get: function() { return origMediaSrcDesc.get.call(this); },
      set: function(val) {
        const resolved = resolveUrl(val);
        return origMediaSrcDesc.set.call(this, resolved === null ? BLOCKED_AUDIO_DATA : (resolved || val));
      },
      configurable: true,
      enumerable: true
    });
  }

  // 5b. Intercepta HTMLScriptElement
  const scriptProto = HTMLScriptElement.prototype;
  const origScriptSrcDesc = Object.getOwnPropertyDescriptor(scriptProto, 'src');
  if (origScriptSrcDesc && origScriptSrcDesc.set) {
    Object.defineProperty(scriptProto, 'src', {
      get: function() { return origScriptSrcDesc.get.call(this); },
      set: function(val) {
        const resolved = resolveUrl(val);
        if (resolved === null) {
          console.warn('[Pluck Replay Shim] Blocked external unmapped script:', val);
          this.type = 'application/blocked';
          setTimeout(() => {
            if (typeof this.onload === 'function') this.onload(new Event('load'));
          }, 0);
          return;
        }
        return origScriptSrcDesc.set.call(this, resolved || val);
      },
      configurable: true,
      enumerable: true
    });
  }

  // 5c. Intercepta navigator.sendBeacon
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon = function(url, data) {
      console.warn('[Pluck Replay Shim] Mocked sendBeacon to:', url);
      return true;
    };
  }

  // 6. Intercepta setAttribute em Element
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, val) {
    const lower = String(name).toLowerCase();
    if (lower === 'src') {
      const isScript = this.tagName === 'SCRIPT';
      const resolved = resolveUrl(val);
      if (resolved === null) {
        if (isScript) {
          this.setAttribute('type', 'application/blocked');
          setTimeout(() => {
            if (typeof this.onload === 'function') this.onload(new Event('load'));
          }, 0);
          return;
        }
        val = BLOCKED_IMAGE_DATA;
      } else {
        val = resolved || val;
      }
    } else if (lower === 'srcset') {
      val = rewriteSrcset(val);
    } else if (lower === 'style' && val && typeof val === 'string') {
      val = rewriteCssUrls(val);
    }
    return origSetAttribute.call(this, name, val);
  };

  // 7. Intercepta CSSStyleDeclaration (setProperty, backgroundImage, background)
  const styleProto = CSSStyleDeclaration.prototype;
  const origSetProperty = styleProto.setProperty;
  styleProto.setProperty = function(prop, val, priority) {
    if (val && typeof val === 'string' && val.includes('url(')) {
      val = rewriteCssUrls(val);
    }
    return origSetProperty.call(this, prop, val, priority);
  };

  const origBgImgDesc = Object.getOwnPropertyDescriptor(styleProto, 'backgroundImage');
  if (origBgImgDesc && origBgImgDesc.set) {
    Object.defineProperty(styleProto, 'backgroundImage', {
      get: function() { return origBgImgDesc.get.call(this); },
      set: function(val) {
        return origBgImgDesc.set.call(this, rewriteCssUrls(val));
      },
      configurable: true,
      enumerable: true
    });
  }

  // 8. Intercepta CSSStyleSheet.prototype.insertRule
  if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.insertRule) {
    const origInsertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function(rule, ...rest) {
      if (rule && typeof rule === 'string') {
        rule = rewriteCssUrls(rule);
      }
      return origInsertRule.call(this, rule, ...rest);
    };
  }

  // 9. Intercepta Worker
  const OrigWorker = window.Worker;
  if (OrigWorker) {
    window.Worker = function(scriptUrl, options) {
      const resolved = resolveUrl(scriptUrl);
      return new OrigWorker(resolved === null ? BLOCKED_SCRIPT_DATA : (resolved || scriptUrl), options);
    };
    window.Worker.prototype = OrigWorker.prototype;
  }

  // 10. Intercepta WebAssembly Streaming
  if (typeof WebAssembly !== 'undefined') {
    if (WebAssembly.instantiateStreaming) {
      const origInst = WebAssembly.instantiateStreaming;
      WebAssembly.instantiateStreaming = function(source, importObject) {
        if (source && typeof source.then === 'function') {
          source = source.then(res => {
            if (res && res.url) {
              const r = resolveUrl(res.url);
              if (r && r !== res.url) return fetch(r);
            }
            return res;
          });
        }
        return origInst.call(this, source, importObject);
      };
    }
    if (WebAssembly.compileStreaming) {
      const origCompile = WebAssembly.compileStreaming;
      WebAssembly.compileStreaming = function(source) {
        if (source && typeof source.then === 'function') {
          source = source.then(res => {
            if (res && res.url) {
              const r = resolveUrl(res.url);
              if (r && r !== res.url) return fetch(r);
            }
            return res;
          });
        }
        return origCompile.call(this, source);
      };
    }
  }

  // 11. Proteção contra overlays travados (.transition-w) e limpeza de canvas duplicado
  window.addEventListener('DOMContentLoaded', () => {
    const glWrap = document.querySelector('.gl-wrap');
    if (glWrap && glWrap.children.length > 0) {
      glWrap.innerHTML = '';
    }
    setTimeout(() => {
      const tw = document.querySelector('.transition-w');
      if (tw && window.getComputedStyle(tw).visibility !== 'hidden') {
        tw.style.visibility = 'hidden';
        tw.style.pointerEvents = 'none';
        const btn = tw.querySelector('.transition-btn');
        if (btn) btn.style.display = 'none';
      }
    }, 2000);
  });
})();`;
}
