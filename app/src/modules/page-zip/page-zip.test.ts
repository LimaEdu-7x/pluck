import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { pageZipModule } from './index';

describe('page-zip Module', () => {
  it('possui metadados corretos', () => {
    expect(pageZipModule.id).toBe('page-zip');
    expect(pageZipModule.badge).toBe('COMPLETO');
    expect(pageZipModule.title).toBe('Página completa em ZIP');
  });

  it('analisa página com recursos linkados', async () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="style.css">
        </head>
        <body>
          <img src="foto.png">
        </body>
      </html>
    `;

    const analysis = await pageZipModule.analyze({
      url: 'https://example.com',
      title: 'Exemplo',
      html
    });

    expect(analysis.totalItems).toBeGreaterThanOrEqual(2);
  });

  it('executa extração empacotando HTML higienizado e recursos em ZIP', async () => {
    const html = '<html><head><script>alert(1)</script></head><body><h1>Teste</h1></body></html>';
    const resources = [
      {
        url: 'https://example.com/style.css',
        type: 'stylesheet' as const,
        data: 'body { color: blue; }'
      }
    ];

    const result = await pageZipModule.run({
      url: 'https://example.com',
      title: 'Minha Pagina',
      html,
      resources
    });

    expect(result.moduleId).toBe('page-zip');
    expect(result.filename).toBe('Minha Pagina.zip');
    expect(result.mimeType).toBe('application/zip');

    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    const unzipped = unzipSync(buffer);

    expect(unzipped['index.html']).toBeDefined();
    expect(unzipped['assets/style.css']).toBeDefined();

    const cleanHtml = new TextDecoder().decode(unzipped['index.html']);
    expect(cleanHtml).not.toContain('<script>');
    expect(cleanHtml).toContain('default-src \'none\'');
  });
});
