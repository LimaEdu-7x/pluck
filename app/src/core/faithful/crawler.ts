// Crawler BFS Fiel com Orçamento de Recursos e Restrição de Domínio

import { CrawlLimits } from './types';
import { validateUrl, isLocalhostPage } from '../security/url-guard';

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
    maxDepth: limits.maxDepth !== undefined ? limits.maxDepth : 3
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

// Normaliza URL removendo hash e barras finais redundantes
export function normalizeCrawlUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
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

// Verifica se uma URL pertence ao escopo permitido (mesma origem ou subdomínio)
export function isUrlInCrawlScope(
  targetUrl: string,
  rootOrigin: string,
  rootHostname: string,
  includeSubdomains: boolean
): boolean {
  try {
    const isRootLocal = isLocalhostPage(rootOrigin);
    // [FIEL-03] Se a raiz não for local, bloqueia qualquer URL para IP privado ou loopback
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
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const anchors = doc.querySelectorAll('a[href]');
  const found: string[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const href = anchors[i].getAttribute('href');
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
          session.limits.includeSubdomains
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
