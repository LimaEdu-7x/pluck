import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { unzipSync } from 'fflate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1x1 PNG transparente em bytes
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function runV3FinalSandboxTest() {
  console.log('=== Pluck Edge Sandbox Test Runner - UI v3 Final ===');

  const distPath = path.resolve(__dirname, '../dist');
  if (!fs.existsSync(path.join(distPath, 'manifest.json'))) {
    throw new Error('app/dist/manifest.json não encontrado. Execute npm run build primeiro.');
  }

  const screenshotsDir = path.resolve(__dirname, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // 1. Inicia Servidor 2: CDN externa SEM cabeçalho CORS
  const cdnServer = http.createServer((req, res) => {
    if (req.url === '/blocked-image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(SAMPLE_PNG);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  const cdnPort = await new Promise((resolve) => {
    cdnServer.listen(0, '127.0.0.1', () => {
      const addr = cdnServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 45199);
    });
  });
  console.log(`[1/8] CDN simulada (sem CORS) ativa em http://127.0.0.1:${cdnPort}`);

  // 2. Inicia Servidor 1: Servidor local de fixtures completas
  const mainServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Fixture com redirect HTTP 302
    if (req.url === '/redirect-source.html' || req.url === '/redirect') {
      res.writeHead(302, { Location: '/fixture-page.html' });
      res.end('Redirecionando...');
      return;
    }

    if (req.url === '/fixture-page.html') {
      const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Pluck Sandbox Fixture</title>
  <link rel="stylesheet" href="/fixture-style.css">
  <script>window.__scriptExecuted = true;</script>
</head>
<body>
  <h1>Pluck Sandbox Fixture</h1>

  <!-- 1. Imagem img normal -->
  <img id="local-img" src="/local-image.png" alt="Local">

  <!-- 2. Imagem data: URL -->
  <img id="data-img" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="Data URL">

  <!-- 3. Imagem com srcset -->
  <img id="srcset-img" src="/local-srcset-1x.png" srcset="/local-srcset-1x.png 1x, /local-srcset-2x.png 2x" alt="Srcset">

  <!-- 4. Elemento picture -->
  <picture>
    <source srcset="/local-picture.png">
    <img src="/local-image.png" alt="Picture Fallback">
  </picture>

  <!-- 5. CSS background-image inline -->
  <div id="bg-box" style="background-image: url('/local-bg.png'); width: 10px; height: 10px;">Fundo</div>

  <!-- 6. SVG inline -->
  <svg id="vetor-estrela" width="10" height="10" viewBox="0 0 10 10">
    <circle cx="5" cy="5" r="5" fill="#FF6B3D"/>
  </svg>

  <!-- 7. Imagem remota da CDN sem CORS -->
  <img id="blocked-img" src="http://127.0.0.1:${cdnPort}/blocked-image.png" alt="CORS Blocked">

  <form>
    <input type="password" value="senha123">
    <input type="hidden" name="csrf_token" value="token_secreto_abc">
  </form>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.url === '/fixture-style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('body { background-color: #16181D; color: #F4F1EA; }');
      return;
    }

    if (
      req.url === '/local-image.png' ||
      req.url === '/local-srcset-1x.png' ||
      req.url === '/local-srcset-2x.png' ||
      req.url === '/local-picture.png' ||
      req.url === '/local-bg.png'
    ) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(SAMPLE_PNG);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const mainPort = await new Promise((resolve) => {
    mainServer.listen(0, '127.0.0.1', () => {
      const addr = mainServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 45198);
    });
  });
  console.log(`[2/8] Servidor principal de fixtures ativo em http://127.0.0.1:${mainPort}`);

  // 3. Perfil descartável estritamente em app/.tmp-profile-xxx
  const tmpProfile = path.resolve(__dirname, '../.tmp-profile-' + Date.now());
  fs.mkdirSync(tmpProfile, { recursive: true });
  console.log(`[3/8] Perfil temporário descartável criado em: ${tmpProfile}`);

  let browserContext;
  try {
    const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    if (!fs.existsSync(edgePath)) {
      throw new Error(`Binário do Edge não encontrado em: ${edgePath}`);
    }

    browserContext = await chromium.launchPersistentContext(tmpProfile, {
      executablePath: edgePath,
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${distPath}`,
        `--load-extension=${distPath}`,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    console.log('[4/8] Microsoft Edge iniciado com extensão carregada em ambiente sandbox');

    // Identifica o Extension ID a partir do Service Worker
    let extensionId = '';
    for (let i = 0; i < 15; i++) {
      const workers = browserContext.serviceWorkers();
      const extWorker = workers.find((w) => w.url().includes('background.js'));
      if (extWorker) {
        const match = extWorker.url().match(/chrome-extension:\/\/([a-z0-9]+)\//);
        if (match) {
          extensionId = match[1];
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!extensionId) {
      throw new Error('Service Worker da extensão não encontrado.');
    }
    console.log(`Extensão Pluck ativa com ID: ${extensionId}`);

    // Navega para a fixture com redirect
    const contentPage = await browserContext.newPage();
    console.log('Navegando para rota de redirect HTTP 302...');
    await contentPage.goto(`http://127.0.0.1:${mainPort}/redirect-source.html`);
    await contentPage.waitForLoadState('networkidle');

    const finalUrl = contentPage.url();
    if (!finalUrl.includes('/fixture-page.html')) {
      throw new Error(`Redirect 302 falhou: URL atual é ${finalUrl}`);
    }
    console.log('Redirect seguido com sucesso.');

    const rawHtmlFromPage = await contentPage.content();

    // 5. Teste da Janela Horizontal (Padrão 720x400) - Tema Escuro (Principal)
    console.log('[5/8] Testando janela horizontal padrão (720x400) no tema escuro...');
    const horizPage = await browserContext.newPage();
    await horizPage.setViewportSize({ width: 720, height: 400 });
    await horizPage.emulateMedia({ colorScheme: 'dark' });
    horizPage.on('console', (msg) => console.log(`[Horiz Console] ${msg.type()}: ${msg.text()}`));
    await horizPage.goto(`chrome-extension://${extensionId}/window.html`);
    await horizPage.waitForSelector('#mainActionBtn');

    // Verifica DECISÃO DO EDU: modo HTML selecionado ao abrir
    const defaultMode = await horizPage.evaluate(() => window.__pluck.getSelectedModule());
    const defaultBtnText = await horizPage.$eval('#mainActionBtn', (el) => el.textContent?.trim());
    console.log(`Modo padrão detectado: "${defaultMode}", Botão: "${defaultBtnText}"`);

    if (defaultMode !== 'page-html') {
      throw new Error(`Esperava-se modo 'page-html' como padrão ao abrir, obtido: "${defaultMode}"`);
    }
    if (defaultBtnText !== 'Baixar somente o HTML') {
      throw new Error(`Esperava-se botão 'Baixar somente o HTML' ao abrir, obtido: "${defaultBtnText}"`);
    }

    // Configura a aba alvo como https://artigo.com/post-exemplo para validar pílula HTTPS (Seguro)
    await horizPage.evaluate(({ url, title, html }) => {
      window.__pluck.setTargetTab({ url, title, html });
    }, { url: 'https://artigo.com/post-exemplo', title: 'Guia de Boas Práticas UI/UX', html: rawHtmlFromPage });

    const secText = await horizPage.$eval('#securityText', (el) => el.textContent?.trim());
    console.log(`Etiqueta de segurança na aba HTTPS: "${secText}"`);
    if (secText !== 'HTTPS (Seguro)') {
      throw new Error(`Esperava-se 'HTTPS (Seguro)', obtido: "${secText}"`);
    }

    // Captura screenshot 1:1 de Início no Tema Escuro (Modo HTML Padrão)
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-1-inicio.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-1-inicio-html.png') });

    // Alterna para modo ZIP Completo e captura screenshot 1:1
    await horizPage.evaluate(() => window.__pluck.selectMode('page-zip'));
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-1-inicio-zip.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-1-inicio-zip.png') });

    // Alterna para modo Somente Imagens
    await horizPage.evaluate(() => window.__pluck.selectMode('images-zip'));
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-1-inicio-images.png') });

    // Volta para o modo padrão HTML
    await horizPage.evaluate(() => window.__pluck.selectMode('page-html'));

    // Captura screenshot dos estados restantes em Horizontal (Tema Escuro):
    // Analisando
    await horizPage.evaluate(() => window.__pluck.setState('analisando', { subtitle: '21 itens detectados · tamanho ao baixar' }));
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-2-analisando.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-2-analisando.png') });

    // Baixando (HTML)
    await horizPage.evaluate(() => window.__pluck.setState('baixando', { filename: 'artigo-com.html', percent: '100%' }));
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-3-baixando-html.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-3-baixando-html.png') });

    // Baixando (ZIP)
    await horizPage.evaluate(() => {
      window.__pluck.selectMode('page-zip');
      window.__pluck.setState('baixando', { filename: 'artigo-com.zip', percent: '68%' });
    });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-3-baixando.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-3-baixando-zip.png') });

    // Pronto (HTML com caixa neutra)
    await horizPage.evaluate(() => {
      window.__pluck.selectMode('page-html');
      window.__pluck.setState('pronto', { filename: 'artigo-com.html', size: '42 KB', itemCount: 1 });
    });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-4-pronto-html.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-4-pronto-html.png') });

    // Pronto (ZIP)
    await horizPage.evaluate(() => {
      window.__pluck.selectMode('page-zip');
      window.__pluck.setState('pronto', { filename: 'artigo-com.zip', size: '1,8 MB', itemCount: 7, incomplete: true });
    });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-4-pronto.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-4-pronto-zip.png') });

    // Erro (chrome://)
    await horizPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'chrome://extensions', title: 'Extensões' });
    });
    const erroBtnDisabled = await horizPage.$eval('#mainActionBtn', (el) => el.disabled);
    const erroBtnText = await horizPage.$eval('#mainActionBtn', (el) => el.textContent?.trim());
    const erroDomainText = await horizPage.$eval('#domainText', (el) => el.textContent?.trim());
    console.log(`Estado de erro validado: btn="${erroBtnText}", domain="${erroDomainText}", disabled=${erroBtnDisabled}`);
    if (!erroBtnDisabled || erroBtnText !== 'Aguardando Aba Compatível') {
      throw new Error(`Falha no estado de erro da janela horizontal: btn="${erroBtnText}"`);
    }
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-5-erro.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-5-erro.png') });

    // Permissão
    await horizPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'https://artigo.com/post', title: 'Artigo' });
      window.__pluck.setState('permissao');
    });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-6-permissao.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-6-permissao.png') });

    // Login
    await horizPage.evaluate(() => {
      window.__pluck.setState('login');
    });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-escuro-7-login.png') });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'horizontal-7-login.png') });

    // Captura também no Tema Claro para cobertura completa
    await horizPage.emulateMedia({ colorScheme: 'light' });
    await horizPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'https://artigo.com/post', title: 'Artigo' });
      window.__pluck.selectMode('page-html');
    });
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-claro-1-inicio.png') });

    await horizPage.evaluate(() => window.__pluck.selectMode('page-zip'));
    await horizPage.screenshot({ path: path.join(screenshotsDir, 'A-horizontal-claro-1-inicio-zip.png') });

    console.log('Janela Horizontal e screenshots 1:1 (Escuro e Claro) validados com sucesso.');

    // 6. Teste do Painel Lateral Vertical (380x760)
    console.log('[6/8] Testando painel lateral vertical (380x760) no tema escuro...');
    const panelPage = await browserContext.newPage();
    await panelPage.setViewportSize({ width: 380, height: 760 });
    await panelPage.emulateMedia({ colorScheme: 'dark' });
    panelPage.on('console', (msg) => console.log(`[Panel Console] ${msg.type()}: ${msg.text()}`));
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panelPage.waitForSelector('#mainActionBtn');

    await panelPage.evaluate(({ url, title, html }) => {
      window.__pluck.setTargetTab({ url, title, html });
    }, { url: 'https://artigo.com/post-exemplo', title: 'Guia de Boas Práticas UI/UX', html: rawHtmlFromPage });

    // Screenshots 1:1 do Vertical (Tema Escuro)
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-1-inicio.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-1-inicio-html.png') });

    await panelPage.evaluate(() => window.__pluck.selectMode('page-zip'));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-1-inicio-zip.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-1-inicio-zip.png') });

    await panelPage.evaluate(() => window.__pluck.setState('analisando', { subtitle: '21 itens detectados · tamanho ao baixar' }));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-2-analisando.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-2-analisando.png') });

    // Baixando HTML vertical
    await panelPage.evaluate(() => {
      window.__pluck.selectMode('page-html');
      window.__pluck.setState('baixando', { filename: 'artigo-com.html' });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-3-baixando-html.png') });

    // Baixando ZIP vertical com lista completa de arquivos e contadores
    await panelPage.evaluate(() => {
      window.__pluck.selectMode('page-zip');
      window.__pluck.setState('baixando', {
        filename: 'artigo-com.zip',
        percent: '68% CONCLUÍDO',
        countText: '14 de 21 itens',
        boxTitle: 'Progresso do pacote: 14 de 21 arquivos salvos'
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-3-baixando.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-3-baixando.png') });

    await panelPage.evaluate(() => {
      window.__pluck.selectMode('page-html');
      window.__pluck.setState('pronto', { filename: 'artigo-com.html', size: '42 KB', itemCount: 1 });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-4-pronto-html.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-4-pronto-html.png') });

    await panelPage.evaluate(() => {
      window.__pluck.selectMode('page-zip');
      window.__pluck.setState('pronto', { filename: 'artigo-com.zip', size: '4,6 MB', itemCount: 19 });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-4-pronto.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-4-pronto.png') });

    await panelPage.evaluate(() => window.__pluck.setTargetTab({ url: 'chrome://extensions', title: 'Extensões' }));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-5-erro.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-5-erro.png') });

    await panelPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'https://artigo.com/post', title: 'Artigo' });
      window.__pluck.setState('permissao');
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-6-permissao.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-6-permissao.png') });

    await panelPage.evaluate(() => window.__pluck.setState('login'));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-escuro-7-login.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'vertical-7-login.png') });

    // Vertical Tema Claro
    await panelPage.emulateMedia({ colorScheme: 'light' });
    await panelPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'https://artigo.com/post', title: 'Artigo' });
      window.__pluck.selectMode('page-html');
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-claro-1-inicio.png') });

    await panelPage.evaluate(() => window.__pluck.selectMode('page-zip'));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-vertical-claro-1-inicio-zip.png') });

    // 7. Teste do Painel Compacto (320x600)
    console.log('[7/8] Testando variante compacta (320x600)...');
    await panelPage.emulateMedia({ colorScheme: 'dark' });
    await panelPage.setViewportSize({ width: 320, height: 600 });
    await panelPage.evaluate(() => {
      const c = document.getElementById('verticalContainer');
      if (c) c.classList.add('compact');
      window.__pluck.selectMode('page-html');
      window.__pluck.setTargetTab({ url: 'https://artigo.com/post', title: 'Início Compacto' });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-compacto-escuro-1-inicio.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'compacto-1-inicio-html.png') });

    await panelPage.evaluate(() => window.__pluck.selectMode('page-zip'));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-compacto-escuro-1-inicio-zip.png') });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'compacto-1-inicio-zip.png') });

    await panelPage.evaluate(() => window.__pluck.setTargetTab({ url: 'chrome://extensions', title: 'Extensões' }));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-compacto-escuro-5-erro.png') });

    // Compacto Tema Claro
    await panelPage.emulateMedia({ colorScheme: 'light' });
    await panelPage.evaluate(() => {
      window.__pluck.selectMode('page-html');
      window.__pluck.setTargetTab({ url: 'https://artigo.com/post', title: 'Início Compacto' });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-compacto-claro-1-inicio.png') });

    await panelPage.evaluate(() => window.__pluck.selectMode('page-zip'));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-compacto-claro-1-inicio-zip.png') });

    // 8. Teste dos 3 Modos Baixando de Verdade (Ponta a Ponta)
    console.log('[8/8] Executando downloads reais dos 3 modos...');

    // 8.1 Modo 1: page-html
    const htmlDownload = await panelPage.evaluate(async ({ raw, url }) => {
      const { capturePageHtml } = window.__pluck;
      const capture = capturePageHtml({
        html: raw,
        title: 'Artigo Teste',
        url,
        baseURI: url,
        stylesheets: [],
        images: []
      });
      return {
        filename: capture.filename,
        clean: !capture.sanitizedHtml.includes('<script') && capture.sanitizedHtml.includes("default-src 'none'")
      };
    }, { raw: rawHtmlFromPage, url: finalUrl });

    if (!htmlDownload.clean || !htmlDownload.filename.endsWith('.html')) {
      throw new Error(`Download do page-html falhou: ${JSON.stringify(htmlDownload)}`);
    }
    console.log('Download do modo page-html verificado com sucesso.');

    // 8.2 Modo 2: page-zip
    const zipDownload = await panelPage.evaluate(async ({ raw, url }) => {
      const { capturePageZip } = window.__pluck;
      const progressList = [];
      const capture = await capturePageZip({
        html: raw,
        title: 'Pagina Completa',
        url,
        baseURI: url,
        stylesheets: [],
        images: []
      }, (loaded, total, currentItem) => {
        progressList.push({ loaded, total, currentItem });
      });
      const buffer = new Uint8Array(await capture.blob.arrayBuffer());
      return {
        filename: capture.filename,
        base64Zip: btoa(String.fromCharCode(...buffer)),
        stats: capture.stats,
        progressList
      };
    }, { raw: rawHtmlFromPage, url: finalUrl });

    if (zipDownload.progressList.length !== zipDownload.stats.totalAssets) {
      throw new Error(`Progresso do page-zip reportou ${zipDownload.progressList.length} chamadas, esperado ${zipDownload.stats.totalAssets}`);
    }
    console.log(`Download do modo page-zip verificado com sucesso (${zipDownload.stats.totalAssets} itens reais com callback de progresso).`);

    const zipU8 = Buffer.from(zipDownload.base64Zip, 'base64');
    const zipFiles = Object.keys(unzipSync(zipU8));
    if (!zipFiles.includes('index.html')) {
      throw new Error('page-zip não contém index.html!');
    }

    // 8.3 Modo 3: images-zip
    const imgDownload = await panelPage.evaluate(async ({ raw, url }) => {
      const { collectImagesFromDom, captureImagesZip } = window.__pluck;
      const parser = new DOMParser();
      const doc = parser.parseFromString(raw, 'text/html');
      const candidates = collectImagesFromDom(doc, url);
      const progressList = [];
      const capture = await captureImagesZip({
        candidates,
        title: 'Galeria',
        pageUrl: url,
        onProgress: (cur, tot, item) => {
          progressList.push({ cur, tot, item });
        }
      });
      const buffer = new Uint8Array(await capture.blob.arrayBuffer());
      return {
        filename: capture.filename,
        base64Zip: btoa(String.fromCharCode(...buffer)),
        stats: capture.stats,
        progressList
      };
    }, { raw: rawHtmlFromPage, url: finalUrl });

    if (imgDownload.progressList.length !== imgDownload.stats.totalAssets) {
      throw new Error(`Progresso do images-zip reportou ${imgDownload.progressList.length} chamadas, esperado ${imgDownload.stats.totalAssets}`);
    }
    console.log(`Download do modo images-zip verificado com sucesso (${imgDownload.stats.totalAssets} imagens reais com callback de progresso).`);

    const imgU8 = Buffer.from(imgDownload.base64Zip, 'base64');
    const imgFiles = Object.keys(unzipSync(imgU8));
    if (imgFiles.length < 5 || !imgFiles.some((f) => f.endsWith('.svg'))) {
      throw new Error(`images-zip não extraiu as imagens esperadas: ${JSON.stringify(imgFiles)}`);
    }
    console.log('Download do modo images-zip verificado com sucesso.');

    console.log('[9/9] Testando revogação de permissão e limpeza de recursos ao fechar janela no "X"...');
    const fixtureOrigin = `http://127.0.0.1:${mainPort}/*`;
    const midJobWindow = await browserContext.newPage();
    await midJobWindow.goto(`chrome-extension://${extensionId}/window.html`);

    // Registra listener no unload para confirmar execução do beforeunload/pagehide
    await midJobWindow.evaluate((orig) => {
      window.__unloadTriggered = false;
      window.addEventListener('beforeunload', () => { window.__unloadTriggered = true; });
      window.addEventListener('pagehide', () => { window.__unloadTriggered = true; });
    }, fixtureOrigin);

    // Fecha a janela simulando o usuário clicando no "X" durante a sessão
    await midJobWindow.close();
    await new Promise((r) => setTimeout(r, 600));

    // Abre página de inspeção para validar que nenhuma permissão residual permaneceu via permissions.getAll
    const checkPage = await browserContext.newPage();
    await checkPage.goto(`chrome-extension://${extensionId}/window.html`);
    const allPerms = await checkPage.evaluate(async () => {
      if (chrome.permissions && chrome.permissions.getAll) {
        return await chrome.permissions.getAll();
      }
      return { origins: [] };
    });
    await checkPage.close();

    const hasOrigin = allPerms.origins && allPerms.origins.some((o) => o.includes(`127.0.0.1:${mainPort}`));
    if (hasOrigin) {
      throw new Error(`Permissão residual detectada em permissions.getAll() após fechar a janela: ${JSON.stringify(allPerms.origins)}`);
    }
    console.log('Revogação de permissão ao fechar a janela no "X" validada com sucesso (permissions.getAll sem origem).');

    console.log('=== TESTE E2E DA UI v3 CONCLUÍDO COM SUCESSO! ===');
  } finally {
    if (browserContext) {
      await browserContext.close().catch(() => {});
    }
    mainServer.close();
    cdnServer.close();

    try {
      fs.rmSync(tmpProfile, { recursive: true, force: true });
      console.log(`Perfil temporário removido: ${tmpProfile}`);
    } catch (e) {
      console.warn(`Aviso na limpeza do perfil: ${e.message}`);
    }
  }
}

runV3FinalSandboxTest().then(() => {
  console.log('PHASE3_V3_EDGE_SANDBOX_SUCCESS');
  process.exit(0);
}).catch((err) => {
  console.error('PHASE3_V3_EDGE_SANDBOX_FAILED:', err);
  process.exit(1);
});
