import { describe, it, expect } from 'vitest';
import {
  createCrawlSession,
  isUrlInCrawlScope,
  extractCrawlLinks,
  enqueueDiscoveredLinks,
  recordDownloadedBytes
} from './crawler';

describe('Crawler BFS Fiel: Escopo de Domínio e Fila de Crawl', () => {
  const root = 'https://meusite.com';

  it('permite páginas da mesma origem e bloqueia domínios externos', () => {
    expect(isUrlInCrawlScope('https://meusite.com/sobre', root, 'meusite.com', false)).toBe(true);
    expect(isUrlInCrawlScope('https://meusite.com/blog/post-1', root, 'meusite.com', false)).toBe(true);
    expect(isUrlInCrawlScope('https://outro.com/sobre', root, 'meusite.com', false)).toBe(false);
    expect(isUrlInCrawlScope('http://meusite.com/sobre', root, 'meusite.com', false)).toBe(false); // protocolo diferente
  });

  it('bloqueia links para localhost e IPs privados/loopback quando o crawler está em site público (FIEL-03)', () => {
    expect(isUrlInCrawlScope('http://127.0.0.1:8080/admin', root, 'meusite.com', false)).toBe(false);
    expect(isUrlInCrawlScope('http://localhost:3000/', root, 'meusite.com', false)).toBe(false);
    expect(isUrlInCrawlScope('http://192.168.1.1/setup', root, 'meusite.com', false)).toBe(false);
    expect(isUrlInCrawlScope('http://10.0.0.1/secret', root, 'meusite.com', false)).toBe(false);
    expect(isUrlInCrawlScope('http://[::1]:8080/data', root, 'meusite.com', false)).toBe(false);
  });

  it('respeita opção de incluir subdomínios', () => {
    expect(isUrlInCrawlScope('https://blog.meusite.com/post', root, 'meusite.com', true)).toBe(true);
    expect(isUrlInCrawlScope('https://app.meusite.com/', root, 'meusite.com', true)).toBe(true);
    expect(isUrlInCrawlScope('https://blog.meusite.com/post', root, 'meusite.com', false)).toBe(false);
    expect(isUrlInCrawlScope('https://meusite.com.atacante.com/', root, 'meusite.com', true)).toBe(false);
  });

  it('extrai links internos válidos e descarta âncoras locais, javascript: e binários', () => {
    const session = createCrawlSession('https://meusite.com/');
    const html = `
      <div>
        <a href="/sobre">Sobre</a>
        <a href="https://meusite.com/contato">Contato</a>
        <a href="#secao">Âncora Local</a>
        <a href="javascript:void(0)">JS</a>
        <a href="https://facebook.com/meusite">Rede Externa</a>
        <a href="/downloads/instalador.exe">Binário Executável</a>
      </div>
    `;

    const links = extractCrawlLinks(html, 'https://meusite.com/', session);

    expect(links).toContain('https://meusite.com/sobre');
    expect(links).toContain('https://meusite.com/contato');
    expect(links).not.toContain('https://facebook.com/meusite');
    expect(links).not.toContain('https://meusite.com/downloads/instalador.exe');
    expect(links.length).toBe(2);
  });

  it('respeita os limites máximos de páginas e profundidade na fila BFS', () => {
    const session = createCrawlSession('https://meusite.com/', { maxPages: 3, maxDepth: 1 });
    session.queuedUrls.shift(); // Página raiz desenfileirada para processamento
    session.visitedUrls.add('https://meusite.com/');

    enqueueDiscoveredLinks(
      session,
      ['https://meusite.com/p1', 'https://meusite.com/p2', 'https://meusite.com/p3', 'https://meusite.com/p4'],
      0
    );

    // Como maxPages é 3 e 1 já foi visitada, apenas 2 devem entrar na fila
    expect(session.queuedUrls.length).toBe(2);
  });

  it('interrompe a sessão ao atingir o teto de bytes (limite de MB)', () => {
    const session = createCrawlSession('https://meusite.com/', { maxBytes: 1024 * 1024 }); // 1 MB
    expect(recordDownloadedBytes(session, 500 * 1024)).toBe(false);
    expect(session.isFinished).toBe(false);

    // Ultrapassa 1 MB
    expect(recordDownloadedBytes(session, 600 * 1024)).toBe(true);
    expect(session.isFinished).toBe(true);
  });
});
