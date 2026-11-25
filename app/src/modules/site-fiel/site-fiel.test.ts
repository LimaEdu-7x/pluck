import { describe, it, expect } from 'vitest';
import { siteFielModule } from './index';
import { unzipSync } from 'fflate';

describe('Módulo Site Fiel: Análise e Execução', () => {
  it('analisa o DOM identificando scripts, folhas de estilo e imagens', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="stylesheet" href="style.css">
          <script src="app.js"></script>
        </head>
        <body>
          <img src="foto.webp">
          <svg><circle r="10"/></svg>
        </body>
      </html>
    `;

    const result = await siteFielModule.analyze({
      url: 'https://exemplo.com/',
      title: 'Exemplo',
      html
    });

    expect(result.moduleId).toBe('site-fiel');
    expect(result.totalItems).toBe(5); // 1 html + 1 css + 1 js + 2 imagens/svg
    expect(result.items.length).toBe(4);
  });

  it('executa a captura fiel gerando ZIP com index.html, README.txt, abrir.bat e abrir.sh', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Site Fiel Teste</title>
        </head>
        <body>
          <h1>Olá Mundo Fiel</h1>
        </body>
      </html>
    `;

    const runResult = await siteFielModule.run({
      url: 'https://exemplo.com/',
      title: 'Site Fiel Teste',
      html
    });

    expect(runResult.moduleId).toBe('site-fiel');
    expect(runResult.filename).toContain('site-fiel-teste-fiel.zip');
    expect(runResult.blob).toBeDefined();

    const u8 = new Uint8Array(await runResult.blob.arrayBuffer());
    const unzipped = unzipSync(u8);

    expect(unzipped['index.html']).toBeDefined();
    expect(unzipped['README.txt']).toBeDefined();
    expect(unzipped['abrir.bat']).toBeDefined();
    expect(unzipped['abrir.sh']).toBeDefined();

    const indexContent = new TextDecoder().decode(unzipped['index.html']);
    expect(indexContent).toContain('Content-Security-Policy');
    expect(indexContent).toContain('Olá Mundo Fiel');
  });
});
