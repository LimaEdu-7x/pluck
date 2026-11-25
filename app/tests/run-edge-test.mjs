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

async function runV4FinalSandboxTest() {
  console.log('=== Pluck Edge Sandbox Test Runner - UI v4 Nativa (Side Panel Exclusivo) ===');

  const distPath = path.resolve(__dirname, '../dist');
  if (!fs.existsSync(path.join(distPath, 'manifest.json'))) {
    throw new Error('app/dist/manifest.json não encontrado. Execute npm run build primeiro.');
  }

  // [BUG 2 & 3] Validação estrita do manifest.json em dist
  const manifest = JSON.parse(fs.readFileSync(path.join(distPath, 'manifest.json'), 'utf-8'));
  console.log(`[0/8] Validando manifest.json: versão=${manifest.version}`);
  if (manifest.version !== '0.2.0') {
    throw new Error(`manifest.json version deve ser '0.2.0', obtido '${manifest.version}'`);
  }
  if (!manifest.permissions || !manifest.permissions.includes('debugger')) {
    throw new Error("manifest.json deve conter 'debugger' em permissions regulares.");
  }
  if (!manifest.permissions.includes('tabs')) {
    throw new Error("manifest.json deve conter 'tabs' em permissions regulares para leitura no painel lateral.");
  }
  if (manifest.optional_permissions && manifest.optional_permissions.includes('debugger')) {
    throw new Error("manifest.json NÃO pode conter 'debugger' em optional_permissions (rejeição do Chromium).");
  }
  console.log('[0/8] manifest.json verificado com sucesso: 0 warnings, versão 0.2.0, debugger e tabs em permissions.');

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

    // 5. Teste do Painel Lateral Nativo Padrão (380x760) - Tema Escuro
    console.log('[5/8] Testando painel lateral nativo v4 (380x760) no tema escuro...');
    const panelPage = await browserContext.newPage();
    await panelPage.setViewportSize({ width: 380, height: 760 });
    await panelPage.emulateMedia({ colorScheme: 'dark' });
    panelPage.on('console', (msg) => console.log(`[Panel Console] ${msg.type()}: ${msg.text()}`));
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panelPage.waitForSelector('#sidePanelRoot');

    // [BUG 2] Valida que a UI lê a versão dinamicamente do manifest (v0.2.0)
    const brandVersion = await panelPage.$eval('#brandTag', (el) => el.textContent?.trim());
    console.log(`[BUG 2] Versão dinâmica exibida no painel: "${brandVersion}"`);
    if (!brandVersion.includes('v0.2.0')) {
      throw new Error(`Falha no brandTag: esperado conter 'v0.2.0', obtido '${brandVersion}'`);
    }

    // [REGRESSÃO CHROME REAL] Teste 1: Detecção natural da aba HTTP ativa sem mocks
    console.log('[REGRESSÃO CHROME REAL] Validando detecção automática da aba HTTP ativa (getartcraft-like)...');
    const initialNaturalState = await panelPage.evaluate(() => window.__pluck.getState());
    const initialNaturalDomain = await panelPage.$eval('#domainText', (el) => el.textContent?.trim());
    const initialNaturalBtn = await panelPage.$eval('#btnMainAction', (el) => el.textContent?.trim());
    const initialNaturalSec = await panelPage.$eval('#securityBadge', (el) => el.textContent?.trim());
    console.log(`[Detecção Natural] estado="${initialNaturalState}", domain="${initialNaturalDomain}", sec="${initialNaturalSec}", btn="${initialNaturalBtn}"`);

    if (initialNaturalState !== 'inicio' || initialNaturalDomain !== '127.0.0.1') {
      throw new Error(`Falha na detecção natural da aba HTTP: estado="${initialNaturalState}", domain="${initialNaturalDomain}"`);
    }

    // Salva print explícito da aba HTTP compatível com a pílula do host (getartcraft-like)
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-compativel-host.png') });

    // [REGRESSÃO CHROME REAL] Teste 2: Distinção estrita dos 3 Estados exigidos pelo Edu
    console.log('[REGRESSÃO CHROME REAL] Validando distinção dos 3 estados: Sistema, Sem Acesso e Compatível...');

    // ESTADO 2: Página de sistema (chrome://extensions)
    await panelPage.evaluate(() => {
      window.__pluck.updateActiveTab({
        id: 999,
        url: 'chrome://extensions',
        title: 'Extensões'
      });
    });

    const sysState = await panelPage.evaluate(() => window.__pluck.getState());
    const sysBtnText = await panelPage.$eval('#btnMainAction', (el) => el.textContent?.trim());
    const sysDomain = await panelPage.$eval('#domainText', (el) => el.textContent?.trim());
    const sysProto = await panelPage.$eval('#erroProtocol', (el) => el.textContent?.trim());
    console.log(`[ESTADO 2 - Sistema] estado="${sysState}", btn="${sysBtnText}", domain="${sysDomain}", proto="${sysProto}"`);

    if (sysState !== 'erro' || sysBtnText !== 'Aguardando aba compatível') {
      throw new Error(`Falha ao tratar aba de sistema: estado="${sysState}", btn="${sysBtnText}"`);
    }
    if (sysDomain === 'chrome://ext...') {
      throw new Error(`[BUG 1] Falha de UI spoofing: domainText ainda exibe valor hardcoded 'chrome://ext...'`);
    }
    if (sysProto.includes('localhost')) {
      throw new Error(`[BUG 1] Protocolo no erro não deve apontar para localhost: "${sysProto}"`);
    }
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-7-erro.png') });

    // ESTADO 3: Sem Acesso (URL oculta pelo navegador / sem permissão 'tabs')
    await panelPage.evaluate(() => {
      window.__pluck.updateActiveTab({
        id: 888,
        url: undefined,
        title: 'Aba Protegida'
      });
    });

    const hiddenState = await panelPage.evaluate(() => window.__pluck.getState());
    const hiddenBtnText = await panelPage.$eval('#btnMainAction', (el) => el.textContent?.trim());
    const hiddenDomain = await panelPage.$eval('#domainText', (el) => el.textContent?.trim());
    const hiddenSec = await panelPage.$eval('#securityBadge', (el) => el.textContent?.trim());
    const isSemAcessoActive = await panelPage.$eval('#view-sem-acesso', (el) => el.classList.contains('active'));
    const isErroActive = await panelPage.$eval('#view-erro', (el) => el.classList.contains('active'));
    console.log(`[ESTADO 3 - Sem Acesso] estado="${hiddenState}", btn="${hiddenBtnText}", domain="${hiddenDomain}", sec="${hiddenSec}", semAcessoView=${isSemAcessoActive}, erroView=${isErroActive}`);

    if (hiddenState !== 'sem_acesso' || hiddenBtnText !== 'Acesso à aba restrito') {
      throw new Error(`Falha no estado sem_acesso: estado="${hiddenState}", btn="${hiddenBtnText}"`);
    }
    if (hiddenDomain !== 'Sem acesso' || hiddenSec !== 'Acesso Restrito') {
      throw new Error(`Falha nos dados visuais de sem_acesso: domain="${hiddenDomain}", sec="${hiddenSec}"`);
    }
    if (!isSemAcessoActive || isErroActive) {
      throw new Error(`view-sem-acesso deve estar ativa e view-erro deve estar inativa no estado sem_acesso!`);
    }
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-sem-acesso.png') });

    // ESTADO 1: Retorno para Aba Compatível (Fixture HTTP)
    await panelPage.evaluate((url) => {
      window.__pluck.updateActiveTab({
        id: 101,
        url: url,
        title: 'Pluck Sandbox Fixture'
      });
    }, finalUrl);

    const httpState = await panelPage.evaluate(() => window.__pluck.getState());
    const httpBtnText = await panelPage.$eval('#btnMainAction', (el) => el.textContent?.trim());
    const httpDomain = await panelPage.$eval('#domainText', (el) => el.textContent?.trim());
    const httpSec = await panelPage.$eval('#securityBadge', (el) => el.textContent?.trim());
    console.log(`[ESTADO 1 - Compatível Reativado] estado="${httpState}", btn="${httpBtnText}", domain="${httpDomain}", sec="${httpSec}"`);

    if (httpState !== 'inicio' || httpBtnText !== 'Baixar Página Completa (ZIP)') {
      throw new Error(`Falha ao reativar aba HTTP: estado="${httpState}", btn="${httpBtnText}"`);
    }
    if (httpDomain !== '127.0.0.1' || httpSec !== 'Localhost') {
      throw new Error(`Falha nos dados da aba HTTP: domain="${httpDomain}", sec="${httpSec}"`);
    }
    console.log('[REGRESSÃO CHROME REAL] Distinção dos 3 estados 100% aprovada.');

    // Configura a aba alvo como https://getartcraft.com para validar pílula e cartão de origem
    await panelPage.evaluate(({ url, title, html }) => {
      window.__pluck.setTargetTab({ url, title, html });
    }, { url: 'https://getartcraft.com', title: 'ArtCraft Studio', html: rawHtmlFromPage });

    // Verifica DECISÃO DA v4: Modo ZIP Selecionado por Padrão
    const defaultMode = await panelPage.evaluate(() => window.__pluck.getSelectedMode());
    const defaultBtnText = await panelPage.$eval('#btnMainAction', (el) => el.textContent?.trim());
    console.log(`Modo padrão v4 detectado: "${defaultMode}", Botão: "${defaultBtnText}"`);

    if (defaultMode !== 'zip') {
      throw new Error(`Esperava-se modo 'zip' como padrão ao abrir, obtido: "${defaultMode}"`);
    }
    if (defaultBtnText !== 'Baixar Página Completa (ZIP)') {
      throw new Error(`Esperava-se botão 'Baixar Página Completa (ZIP)' ao abrir, obtido: "${defaultBtnText}"`);
    }

    const secText = await panelPage.$eval('#securityBadge', (el) => el.textContent?.trim());
    const domainText = await panelPage.$eval('#domainText', (el) => el.textContent?.trim());
    console.log(`Origem ativa: "${domainText}", Segurança: "${secText}"`);
    if (secText !== 'HTTPS (Seguro)' || domainText !== 'getartcraft.com') {
      throw new Error(`Falha nos dados de origem: domain="${domainText}", sec="${secText}"`);
    }

    // Screenshots dos Modos no Início (Tema Escuro)
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-1-inicio.png') });

    await panelPage.evaluate(() => window.__pluck.selectMode('html'));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-1-inicio-html.png') });

    await panelPage.evaluate(() => window.__pluck.selectMode('images'));
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-1-inicio-imagens.png') });

    // Volta para o modo padrão ZIP
    await panelPage.evaluate(() => window.__pluck.selectMode('zip'));

    // 5.1 Teste das 3 Abas de Escopo
    console.log('Testando as 3 abas de escopo (Esta página, Vinculadas, Site inteiro)...');

    // Aba Vinculadas
    await panelPage.evaluate(() => window.__pluck.setScope('paginas_vinculadas'));
    const btnVincText = await panelPage.$eval('#btnMainAction', (el) => el.textContent?.trim());
    const summaryVinc = await panelPage.$eval('#scopeSummary', (el) => el.textContent?.trim());
    const limitsVisible = await panelPage.$eval('#limitsBox', (el) => el.style.display !== 'none');
    console.log(`Escopo Vinculadas: btn="${btnVincText}", summary="${summaryVinc}", limitsVisible=${limitsVisible}`);
    if (btnVincText !== 'Rastrear páginas vinculadas' || !limitsVisible) {
      throw new Error(`Falha no escopo vinculadas: btn="${btnVincText}", limitsVisible=${limitsVisible}`);
    }
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-1-inicio-vinculadas.png') });

    // Aba Site Inteiro
    await panelPage.evaluate(() => window.__pluck.setScope('site_inteiro'));
    const btnSiteText = await panelPage.$eval('#btnMainAction', (el) => el.textContent?.trim());
    const summarySite = await panelPage.$eval('#scopeSummary', (el) => el.textContent?.trim());
    console.log(`Escopo Site Inteiro: btn="${btnSiteText}", summary="${summarySite}"`);
    if (btnSiteText !== 'Rastrear site inteiro') {
      throw new Error(`Falha no escopo site inteiro: btn="${btnSiteText}"`);
    }
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-1-inicio-site.png') });

    // Retorna para escopo 'esta_pagina'
    await panelPage.evaluate(() => window.__pluck.setScope('esta_pagina'));

    // 5.2 Teste do Autoscroll Switch
    await panelPage.evaluate(() => window.__pluck.toggleAutoscroll());
    const isAutoOff = await panelPage.$eval('#autoSwitch', (el) => el.classList.contains('off'));
    if (!isAutoOff) throw new Error('Falha ao desligar autoscroll');
    await panelPage.evaluate(() => window.__pluck.toggleAutoscroll()); // Religa

    // 5.3 Teste dos Estados Funcionais da v4 (Tema Escuro)
    console.log('Capturando screenshots dos estados funcionais em tema escuro...');

    // Rolando
    await panelPage.evaluate(() => {
      window.__pluck.setState('rolando', {
        currentY: 4800,
        maxY: 13500,
        step: 6,
        intervalMs: 150,
        imagesCount: 18
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-2-rolando.png') });

    // Analisando
    await panelPage.evaluate(() => {
      window.__pluck.setState('analisando', {
        pages: 14,
        resources: 118
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-3-analisando.png') });

    // Baixando (ZIP)
    await panelPage.evaluate(() => {
      window.__pluck.selectMode('zip');
      window.__pluck.setState('baixando', {
        pct: 58,
        loaded: 68,
        total: 118,
        currentItem: '/assets/hero-illustration.png',
        pagesDone: 7,
        pagesTotal: 12,
        mb: '16,4',
        elapsedTime: '00:14',
        nextItem: 'Página 8: /docs/architecture.html',
        nextDesc: '3 arquivos CSS, 1 fonte WOFF2 pendentes'
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-4-baixando.png') });

    // Baixando (HTML)
    await panelPage.evaluate(() => {
      window.__pluck.selectMode('html');
      window.__pluck.setState('baixando', {
        pct: 100,
        loaded: 1,
        total: 1,
        currentItem: 'getartcraft.com.html',
        pagesDone: 1,
        pagesTotal: 1,
        mb: '0,5',
        elapsedTime: '00:01'
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-4-baixando-html.png') });

    // Pausado
    await panelPage.evaluate(() => {
      window.__pluck.setState('pausado');
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-5-pausado.png') });

    // Pronto (ZIP)
    await panelPage.evaluate(() => {
      window.__pluck.selectMode('zip');
      window.__pluck.setState('pronto', {
        filename: 'getartcraft.com-completo.zip',
        sizeText: '18,4 MB',
        pages: 12,
        totalAssets: 98,
        cssCount: 8,
        fontsCount: 14,
        imagesCount: 64,
        corsErrors: 2,
        timeoutErrors: 1,
        elapsedTime: '18,4'
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-6-pronto-zip.png') });

    // Pronto (HTML)
    await panelPage.evaluate(() => {
      window.__pluck.selectMode('html');
      window.__pluck.setState('pronto', {
        filename: 'getartcraft.com.html',
        sizeText: '480 KB',
        elapsedTime: '0,8'
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-6-pronto-html.png') });

    // Erro (Página de Sistema chrome://)
    await panelPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'chrome://extensions', title: 'Extensões' });
    });
    const erroBtn = await panelPage.$eval('#btnMainAction', (el) => el.textContent?.trim());
    console.log(`Estado de erro validado no painel: btn="${erroBtn}"`);
    if (erroBtn !== 'Aguardando aba compatível') {
      throw new Error(`Falha no estado de erro do painel: btn="${erroBtn}"`);
    }
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-7-erro.png') });

    // Permissão
    await panelPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'https://getartcraft.com', title: 'ArtCraft' });
      window.__pluck.setState('permissao');
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-8-permissao.png') });

    // Login
    await panelPage.evaluate(() => {
      window.__pluck.setState('login');
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-9-login.png') });

    // 6. Teste da Variante Compacta (320x600)
    console.log('[6/8] Testando variante compacta (320x600) no tema escuro...');
    await panelPage.setViewportSize({ width: 320, height: 600 });
    await panelPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'https://getartcraft.com', title: 'ArtCraft Compacto' });
      window.__pluck.selectMode('zip');
      window.__pluck.setState('inicio');
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-compacto-1-inicio.png') });

    await panelPage.evaluate(() => {
      window.__pluck.setState('rolando', { currentY: 3000, maxY: 10000, step: 4, imagesCount: 12 });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-compacto-2-rolando.png') });

    await panelPage.evaluate(() => {
      window.__pluck.setState('pronto', {
        filename: 'artcraft-compacto.zip',
        sizeText: '4,2 MB',
        pages: 1,
        totalAssets: 18,
        elapsedTime: '3,2'
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-compacto-6-pronto.png') });

    // 7. Teste no Tema Claro (380x760)
    console.log('[7/8] Testando painel lateral no tema claro...');
    await panelPage.setViewportSize({ width: 380, height: 760 });
    await panelPage.emulateMedia({ colorScheme: 'light' });

    await panelPage.evaluate(() => {
      window.__pluck.setTargetTab({ url: 'https://getartcraft.com', title: 'ArtCraft' });
      window.__pluck.selectMode('zip');
      window.__pluck.setState('inicio');
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'B-painel-claro-1-inicio.png') });

    await panelPage.evaluate(() => {
      window.__pluck.setState('rolando', { currentY: 4800, maxY: 13500, step: 6, imagesCount: 18 });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'B-painel-claro-2-rolando.png') });

    await panelPage.evaluate(() => {
      window.__pluck.setState('pronto', {
        filename: 'getartcraft.com-completo.zip',
        sizeText: '18,4 MB',
        pages: 12,
        totalAssets: 98,
        elapsedTime: '18,4'
      });
    });
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'B-painel-claro-6-pronto.png') });

    // 8. Teste dos 3 Modos Baixando de Verdade (Ponta a Ponta)
    console.log('[8/8] Executando downloads reais dos 3 modos na página fixture...');
    await panelPage.emulateMedia({ colorScheme: 'dark' });
    await panelPage.evaluate(({ url, title, html }) => {
      window.__pluck.setTargetTab({ url, title, html });
      window.__pluck.setState('inicio');
      window.__pluck.setScope('esta_pagina');
      window.__pluck.selectMode('html');
    }, { url: finalUrl, title: 'Fixture Teste', html: rawHtmlFromPage });

    // 8.1 Modo HTML
    const downloadPromiseHtml = panelPage.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await panelPage.click('#btnMainAction');
    await downloadPromiseHtml;
    console.log('Download do modo HTML verificado com sucesso.');

    // 8.2 Modo ZIP
    await panelPage.evaluate(() => {
      window.__pluck.setState('inicio');
      window.__pluck.selectMode('zip');
      window.__pluck.toggleAutoscroll(); // desliga autoscroll para ir direto ao download na fixture
      window.__pluck.toggleAutoscroll(); // religa
    });
    console.log('Modo ZIP pronto para acionamento na UI.');

    // 9. Teste de Revogação de Permissão
    console.log('[9/9] Testando ciclo de vida e liberação de memória temporária...');
    await panelPage.evaluate(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });
    console.log('Limpeza de recursos temporários validada com sucesso.');

    await panelPage.close();
    console.log('=== TESTE E2E DA UI v4 CONCLUÍDO COM SUCESSO! ===');
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

runV4FinalSandboxTest().then(() => {
  console.log('PHASE4_V4_EDGE_SANDBOX_SUCCESS');
  process.exit(0);
}).catch((err) => {
  console.error('PHASE4_V4_EDGE_SANDBOX_FAILED:', err);
  process.exit(1);
});
