// Crawler BFS Fiel com Orçamento de Recursos e Restrição de Domínio

import { CrawlLimits } from './types';
import { validateUrl, isLocalhostPage } from '../security/url-guard';
import { cleanUrlTokens } from '../security/privacy-cleaner';

export interface QueuedPage {
  url: string;
  depth: number;
}

export interface CrawlSession {
  rootUrl: string;
  rootOrigin: string;
  rootHostname: string;
  limits: CrawlLimits;
  visitedUrls: Set<string>;
  queuedUrls: QueuedPage[];
  totalBytesDownloaded: number;
  isFinished: boolean;
}

export function createCrawlSession(
  startUrl: string,
  limits: Partial<CrawlLimits> = {}
): CrawlSession {
  const urlObj = new URL(startUrl);
  const cleanStartUrl = normalizeCrawlUrl(startUrl);

  const finalLimits: CrawlLimits = {
    maxPages: limits.maxPages || 50,
    maxBytes: limits.maxBytes || 200 * 1024 * 1024, // 200 MB
    includeSubdomains: !!limits.includeSubdomains,
    maxDepth: limits.maxDepth !== undefined ? limits.maxDepth : 3,
    allowedExternalDomains: limits.allowedExternalDomains ? [...limits.allowedExternalDomains] : []
  };

  return {
    rootUrl: cleanStartUrl,
    rootOrigin: urlObj.origin,
    rootHostname: urlObj.hostname,
    limits: finalLimits,
    visitedUrls: new Set<string>(),
    queuedUrls: [{ url: cleanStartUrl, depth: 0 }],
    totalBytesDownloaded: 0,
    isFinished: false
  };
}

// Normaliza URL removendo hash, barras finais redundantes e tokens sensíveis
export function normalizeCrawlUrl(rawUrl: string): string {
  try {
    const cleaned = cleanUrlTokens(rawUrl);
    const u = new URL(cleaned);
    u.hash = '';
    let normalized = u.href;
    if (normalized.endsWith('/') && u.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return rawUrl;
  }
}

// Verifica se uma URL pertence ao escopo permitido (mesma origem, subdomínio ou domínio externo autorizado)
export function isUrlInCrawlScope(
  targetUrl: string,
  rootOrigin: string,
  rootHostname: string,
  includeSubdomains: boolean,
  allowedExternalDomains: string[] = []
): boolean {
  try {
    const isRootLocal = isLocalhostPage(rootOrigin);
    // [FIEL-03] SSRF Guard: Se a raiz não for local, bloqueia qualquer URL para IP privado ou loopback
    // Esta verificação ocorre antes de qualquer regra de inclusão (inclusive allowedExternalDomains)
    if (!isRootLocal) {
      const validation = validateUrl(targetUrl, false);
      if (!validation.valid) {
        return false;
      }
    }

    const target = new URL(targetUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return false;
    }

    if (target.origin === rootOrigin) {
      return true;
    }

    if (includeSubdomains) {
      const baseClean = rootHostname.replace(/^www\./, '');
      const targetHost = target.hostname.replace(/^www\./, '');
      if (targetHost === baseClean || targetHost.endsWith('.' + baseClean)) {
        return true;
      }
    }

    // [OPÇÃO B] Domínios externos explicitamente autorizados pelo usuário
    if (allowedExternalDomains && allowedExternalDomains.length > 0) {
      const targetHost = target.hostname.toLowerCase().replace(/^www\./, '');
      for (const allowed of allowedExternalDomains) {
        const cleanAllowed = allowed.toLowerCase().trim().replace(/^www\./, '');
        if (targetHost === cleanAllowed || targetHost.endsWith('.' + cleanAllowed)) {
          return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

// Extrai links internos de um documento HTML
export function extractCrawlLinks(
  html: string,
  pageUrl: string,
  session: CrawlSession
): string[] {
  let hrefs: string[] = [];
  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const anchors = doc.querySelectorAll('a[href]');
      for (let i = 0; i < anchors.length; i++) {
        const h = anchors[i].getAttribute('href');
        if (h) hrefs.push(h);
      }
    } catch {}
  }
  if (hrefs.length === 0) {
    const matches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi);
    for (const m of matches) {
      if (m[1]) hrefs.push(m[1]);
    }
  }

  const found: string[] = [];

  for (let i = 0; i < hrefs.length; i++) {
    const href = hrefs[i];
    if (!href) continue;
    if (
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    ) {
      continue;
    }

    try {
      const resolved = new URL(href, pageUrl).href;
      const cleanUrl = normalizeCrawlUrl(resolved);

      // Descarta arquivos binários executáveis/instaladores
      if (/\.(zip|exe|dmg|pkg|tar|gz|7z|apk|iso|msi)$/i.test(cleanUrl)) {
        continue;
      }

      if (
        isUrlInCrawlScope(
          cleanUrl,
          session.rootOrigin,
          session.rootHostname,
          session.limits.includeSubdomains,
          session.limits.allowedExternalDomains || []
        )
      ) {
        if (!found.includes(cleanUrl)) {
          found.push(cleanUrl);
        }
      }
    } catch {}
  }

  return found;
}

// Lista de redes sociais e plataformas externas genéricas a ignorar na detecção
export const IGNORED_EXTERNAL_DOMAINS = new Set([
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'youtube.com',
  'tiktok.com',
  'twitch.tv',
  'linkedin.com',
  'github.com',
  'discord.com',
  'discord.gg',
  'spotify.com',
  'apple.com',
  'google.com',
  'threads.net',
  'pinterest.com',
  'reddit.com',
  't.me',
  'whatsapp.com'
]);

// Detecta domínios externos vinculados na página (ex: loja externa, subdomínios redirecionados)
export async function detectLinkedExternalDomains(
  html: string,
  pageUrl: string
): Promise<string[]> {
  const discovered = new Set<string>();
  let baseObj: URL;
  try {
    baseObj = new URL(pageUrl);
  } catch {
    return [];
  }

  let hrefs: string[] = [];
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const anchors = doc.querySelectorAll('a[href]');
      for (let i = 0; i < anchors.length; i++) {
        const h = anchors[i].getAttribute('href');
        if (h) hrefs.push(h);
      }
    } catch {}
  }
  if (hrefs.length === 0) {
    const matches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi);
    for (const m of matches) {
      if (m[1]) hrefs.push(m[1]);
    }
  }

  const baseCleanHost = baseObj.hostname.toLowerCase().replace(/^www\./, '');

  for (const href of hrefs) {
    if (
      !href ||
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    ) {
      continue;
    }

    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;

      // SSRF guard preliminar
      const check = validateUrl(resolved.href, isLocalhostPage(pageUrl));
      if (!check.valid) continue;

      const host = resolved.hostname.toLowerCase().replace(/^www\./, '');
      if (host === baseCleanHost) continue; // Mesma raiz/domínio

      // Ignora redes sociais
      const isSocial = Array.from(IGNORED_EXTERNAL_DOMAINS).some(
        (s) => host === s || host.endsWith('.' + s)
      );
      if (isSocial) continue;

      // Ignora CDNs puras de assets estáticos
      if (host.includes('cdn.') || host.includes('assets.') || host.includes('website-files.com')) {
        continue;
      }

      discovered.add(host);
    } catch {}
  }

  // Resolução de redirecionamento para identificar o domínio final (ex: store.landonorris.com -> landonorris.store)
  const finalDomains = new Set<string>();

  for (const domain of discovered) {
    finalDomains.add(domain);
    try {
      const testUrl = `https://${domain}/`;
      const res = await fetch(testUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(3000)
      }).catch(() => null);

      if (res && res.url) {
        const dest = new URL(res.url);
        const destHost = dest.hostname.toLowerCase().replace(/^www\./, '');
        const check = validateUrl(res.url, isLocalhostPage(pageUrl));
        if (check.valid && destHost !== baseCleanHost) {
          const isSocial = Array.from(IGNORED_EXTERNAL_DOMAINS).some(
            (s) => destHost === s || destHost.endsWith('.' + s)
          );
          if (!isSocial) {
            finalDomains.add(destHost);
          }
        }
      }
    } catch {}
  }

  return Array.from(finalDomains);
}

// Enfileira novos links respeitando os tetos de páginas e profundidade
export function enqueueDiscoveredLinks(
  session: CrawlSession,
  links: string[],
  currentDepth: number
): void {
  const nextDepth = currentDepth + 1;
  if (session.limits.maxDepth !== undefined && nextDepth > session.limits.maxDepth) {
    return;
  }

  for (const link of links) {
    if (session.visitedUrls.has(link)) continue;
    if (session.queuedUrls.some((q) => q.url === link)) continue;

    // Respeita o orçamento total de páginas
    const totalKnown = session.visitedUrls.size + session.queuedUrls.length;
    if (totalKnown >= session.limits.maxPages) {
      break;
    }

    session.queuedUrls.push({ url: link, depth: nextDepth });
  }
}

// Registra bytes baixados e verifica se atingiu o teto
export function recordDownloadedBytes(session: CrawlSession, bytes: number): boolean {
  session.totalBytesDownloaded += bytes;
  if (session.totalBytesDownloaded >= session.limits.maxBytes) {
    session.isFinished = true;
    return true; // Teto atingido
  }
  return false;
}
