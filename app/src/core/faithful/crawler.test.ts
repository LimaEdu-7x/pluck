import { describe, it, expect } from 'vitest';
import {
  createCrawlSession,
  isUrlInCrawlScope,
  extractCrawlLinks,
  enqueueDiscoveredLinks,
  recordDownloadedBytes,
  detectLinkedExternalDomains
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

  describe('Domínios Externos Vinculados com Confirmação Explícita (Opção B)', () => {
    it('permite páginas de domínio externo explicitamente autorizado em allowedExternalDomains', () => {
      const allowed = ['landonorris.store'];
      expect(isUrlInCrawlScope('https://landonorris.store/', root, 'meusite.com', false, allowed)).toBe(true);
      expect(isUrlInCrawlScope('https://landonorris.store/collections/featured', root, 'meusite.com', false, allowed)).toBe(true);
      expect(isUrlInCrawlScope('https://shop.landonorris.store/item', root, 'meusite.com', false, allowed)).toBe(true);
    });

    it('bloqueia domínios externos não autorizados mesmo quando outro domínio está na lista', () => {
      const allowed = ['landonorris.store'];
      expect(isUrlInCrawlScope('https://outrodominio.com/', root, 'meusite.com', false, allowed)).toBe(false);
      expect(isUrlInCrawlScope('https://evil.com/hack', root, 'meusite.com', false, allowed)).toBe(false);
    });

    it('mantém SSRF guard ativo bloqueando localhost/IP privado mesmo se informado em allowedExternalDomains', () => {
      const allowedWithLocalhost = ['127.0.0.1', 'localhost', '192.168.1.1'];
      expect(isUrlInCrawlScope('http://127.0.0.1:8080/admin', root, 'meusite.com', false, allowedWithLocalhost)).toBe(false);
      expect(isUrlInCrawlScope('http://localhost:3000/keys', root, 'meusite.com', false, allowedWithLocalhost)).toBe(false);
      expect(isUrlInCrawlScope('http://192.168.1.1/router', root, 'meusite.com', false, allowedWithLocalhost)).toBe(false);
    });

    it('extractCrawlLinks inclui domínios externos autorizados e ignora não autorizados', () => {
      const sessionWithAllowed = createCrawlSession('https://meusite.com/', {
        allowedExternalDomains: ['landonorris.store']
      });

      const html = `
        <div>
          <a href="/sobre">Sobre</a>
          <a href="https://landonorris.store/collections">Loja Oficial</a>
          <a href="https://externo-nao-autorizado.com/">Outro</a>
          <a href="https://instagram.com/perfil">Instagram</a>
        </div>
      `;

      const links = extractCrawlLinks(html, 'https://meusite.com/', sessionWithAllowed);

      expect(links).toContain('https://meusite.com/sobre');
      expect(links).toContain('https://landonorris.store/collections');
      expect(links).not.toContain('https://externo-nao-autorizado.com/');
      expect(links).not.toContain('https://instagram.com/perfil');
    });

    it('detectLinkedExternalDomains descobre domínios externos legítimos e descarta redes sociais e IPs privados (SSRF)', async () => {
      const html = `
        <div>
          <a href="/local">Local</a>
          <a href="https://store.landonorris.com/products">Store Subdomain</a>
          <a href="https://landonorris.store/collections">Store Domain</a>
          <a href="https://www.instagram.com/landonorris">Instagram</a>
          <a href="https://twitter.com/landonorris">Twitter</a>
          <a href="http://127.0.0.1:8080/evil">Evil Localhost</a>
          <a href="http://192.168.1.1/router">Evil Router</a>
          <a href="https://cdn.prod.website-files.com/asset.js">CDN Asset</a>
        </div>
      `;

      const detected = await detectLinkedExternalDomains(html, 'https://landonorris.com/');

      expect(detected).toContain('landonorris.store');
      expect(detected).not.toContain('www.instagram.com');
      expect(detected).not.toContain('instagram.com');
      expect(detected).not.toContain('twitter.com');
      expect(detected).not.toContain('127.0.0.1');
      expect(detected).not.toContain('192.168.1.1');
      expect(detected).not.toContain('cdn.prod.website-files.com');
    });

    it('adota os padrões da SPEC-v12: máx 20 páginas, 2 níveis de sublinks e sem subdomínios', () => {
      const session = createCrawlSession('https://meusite.com/');
      expect(session.limits.maxPages).toBe(20);
      expect(session.limits.maxDepth).toBe(2);
      expect(session.limits.includeSubdomains).toBe(false);
    });

    it('suporta modo Sem limite (maxPages: Infinity)', () => {
      const session = createCrawlSession('https://meusite.com/', { maxPages: Infinity });
      expect(session.limits.maxPages).toBe(Infinity);

      session.queuedUrls.shift(); // remove raiz
      const manyLinks = Array.from({ length: 45 }, (_, i) => `https://meusite.com/p-${i}`);
      enqueueDiscoveredLinks(session, manyLinks, 0);

      // Todas as 45 páginas entram na fila sem corte
      expect(session.queuedUrls.length).toBe(45);
    });
  });
});
