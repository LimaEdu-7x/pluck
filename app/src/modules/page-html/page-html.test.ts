import { describe, it, expect } from 'vitest';
import { pageHtmlModule } from './index';

describe('page-html Module', () => {
  it('possui metadados corretos', () => {
    expect(pageHtmlModule.id).toBe('page-html');
    expect(pageHtmlModule.badge).toBe('ARQUIVO ÚNICO');
    expect(pageHtmlModule.title).toBe('HTML autossuficiente');
  });

  it('analisa página e retorna contagem de 1 arquivo HTML', async () => {
    const analysis = await pageHtmlModule.analyze({
      url: 'https://example.com/artigo',
      title: 'Artigo Exemplo',
      html: '<html><body>Conteudo</body></html>'
    });

    expect(analysis.totalItems).toBe(1);
    expect(analysis.items[0].name).toBe('Artigo Exemplo.html');
    expect(analysis.items[0].type).toBe('text/html');
  });

  it('executa extração gerando arquivo .html higienizado e sem ZIP', async () => {
    const dirtyHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Pagina Teste</title>
          <script>console.log("malicioso");</script>
        </head>
        <body>
          <h1>Titulo</h1>
          <input type="password" value="123456">
          <input type="hidden" name="csrf" value="token_secreto">
        </body>
      </html>
    `;

    const result = await pageHtmlModule.run({
      url: 'https://example.com/segura',
      title: 'Pagina Segura',
      html: dirtyHtml
    });

    expect(result.moduleId).toBe('page-html');
    expect(result.filename).toBe('Pagina Segura.html');
    expect(result.mimeType).toBe('text/html');
    expect(result.itemCount).toBe(1);

    const text = await result.blob.text();
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('malicioso');
    expect(text).not.toContain('type="password"');
    expect(text).not.toContain('token_secreto');
    expect(text).toContain('default-src \'none\'');
    expect(text).toContain('Titulo');
  });
});
