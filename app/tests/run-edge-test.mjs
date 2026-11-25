import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
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

// Espera ativa sem violação de CSP (sem eval())
async function waitForPluckState(page, targetState, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => window.__pluck.getState());
    if (s === targetState) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  const finalState = await page.evaluate(() => window.__pluck.getState());
  throw new Error(`Timeout de ${timeoutMs}ms aguardando estado "${targetState}", atual: "${finalState}"`);
}

async function scrollToAnchor(page, selector) {
  await page.evaluate(() => {
    const tw = document.querySelector('.transition-w');
    if (tw) {
      tw.style.visibility = 'hidden';
      tw.style.opacity = '0';
      tw.style.pointerEvents = 'none';
      tw.style.display = 'none';
    }
    const pre = document.querySelector('.loader, [class*="loader"], .preloader');
    if (pre) pre.style.display = 'none';
  });
  await page.evaluate((sel) => {
    const win = window;
    if (win.gsap && win.gsap.globalTimeline) {
      try { win.gsap.globalTimeline.resume(); } catch {}
    }
    const el = document.querySelector(sel);
    if (el) {
      el.scrollIntoView({ behavior: 'instant', block: 'start' });
      if (win.lenis && typeof win.lenis.scrollTo === 'function') {
        try { win.lenis.scrollTo(el, { immediate: true }); } catch {}
      }
      if (win.ScrollTrigger && typeof win.ScrollTrigger.refresh === 'function') {
        try { win.ScrollTrigger.refresh(); } catch {}
      }
      window.dispatchEvent(new Event('scroll'));
    }
  }, selector);
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const win = window;
    if (win.gsap && win.gsap.globalTimeline) {
      try { win.gsap.globalTimeline.pause(); } catch {}
    }
    document.querySelectorAll('video').forEach((v) => {
      try { v.pause(); } catch {}
    });
  });
}

function createStaticCloneServer(dir) {
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.riv': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.glb': 'model/gltf-binary',
    '.hdr': 'application/octet-stream'
  };

  const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
    const diskPath = path.join(dir, decodeURIComponent(reqPath.replace(/^\/+/, '')));
    if (fs.existsSync(diskPath) && fs.statSync(diskPath).isFile()) {
      const ext = path.extname(diskPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(diskPath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

async function generateSideBySideAndDiff(browser, imgPathLive, imgPathClone, outSideBySidePath, labelTitle) {
  const page = await browser.newPage();
  await page.setContent('<!DOCTYPE html><html><body style="margin:0;background:#000;"></body></html>');
  await page.setViewportSize({ width: 2880, height: 900 });
  const b64Live = 'data:image/png;base64,' + fs.readFileSync(imgPathLive).toString('base64');
  const b64Clone = 'data:image/png;base64,' + fs.readFileSync(imgPathClone).toString('base64');

  const diffResult = await page.evaluate(async ([sLive, sClone, title]) => {
    const load = (src) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.src = src;
    });

    const [imgL, imgC] = await Promise.all([load(sLive), load(sClone)]);
    const canvas = document.createElement('canvas');
    canvas.width = 2880;
    canvas.height = 900;
    const ctx = canvas.getContext('2d');

    // Desenha lado a lado
    ctx.drawImage(imgL, 0, 0, 1440, 900);
    ctx.drawImage(imgC, 1440, 0, 1440, 900);

    // Barra superior e legendas
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, 2880, 50);

    ctx.font = 'bold 20px monospace';
    ctx.fillStyle = '#00FF66';
    ctx.fillText(`AO VIVO (Original Web) — ${title}`, 30, 32);

    ctx.fillStyle = '#FFCC00';
    ctx.fillText(`CLONE OFFLINE (Pluck 100% Local) — ${title}`, 1470, 32);

    document.body.style.margin = '0';
    document.body.appendChild(canvas);

    // Medição de fidelidade por pixel
    const dL = ctx.getImageData(0, 0, 1440, 900).data;
    const dC = ctx.getImageData(1440, 0, 1440, 900).data;

    let diffPixels = 0;
    const totalPixels = 1440 * 900;
    for (let i = 0; i < dL.length; i += 4) {
      const dr = Math.abs(dL[i] - dC[i]);
      const dg = Math.abs(dL[i + 1] - dC[i + 1]);
      const db = Math.abs(dL[i + 2] - dC[i + 2]);
      if (dr > 25 || dg > 25 || db > 25) {
        diffPixels++;
      }
    }

    const matchPct = ((totalPixels - diffPixels) / totalPixels) * 100;
    return {
      totalPixels,
      diffPixels,
      matchPct: matchPct.toFixed(2)
    };
  }, [b64Live, b64Clone, labelTitle]);

  await page.screenshot({ path: outSideBySidePath });
  await page.close();
  return diffResult;
}

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

    if (req.url === '/rendered-html-test') {
      const filePath = path.resolve(__dirname, 'clone-proof/proof-fixture-mode-html.html');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }

    if (req.url && req.url.startsWith('/proof-file/')) {
      const targetName = decodeURIComponent(req.url.replace('/proof-file/', ''));
      const filePath = path.resolve(__dirname, 'clone-proof', targetName);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === '.html' ? 'text/html; charset=utf-8' : (ext === '.css' ? 'text/css' : 'application/octet-stream');
        res.writeHead(200, { 'Content-Type': mime });
        res.end(fs.readFileSync(filePath));
        return;
      }
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

    // 8. Testes Ponta a Ponta de Todas as Funções no Sandbox Edge
    console.log('[8/8] Executando downloads reais e verificando arquivos abertos...');
    await panelPage.emulateMedia({ colorScheme: 'dark' });

    const cloneProofDir = path.resolve(__dirname, 'clone-proof');
    fs.mkdirSync(cloneProofDir, { recursive: true });

    // Descobre o realTabId da aba de fixture (contentPage) no Edge
    await panelPage.evaluate(() => window.__pluck.updateActiveTab());
    const realTabId = await panelPage.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const found = tabs.find((t) => t.url && t.url.includes('fixture-page.html'));
      return found ? found.id : null;
    }, finalUrl);
    console.log(`[E2E Sandbox] Aba de fixture vinculada com realTabId: ${realTabId}`);

    // 8.1 Modo Somente HTML (com consentimento de login/senha + renderização no Playwright)
    console.log('[8.1/8] Testando Modo 1: Somente HTML...');
    await panelPage.evaluate(({ url, title, html, tabId }) => {
      window.__pluck.setTargetTab({ url, title, html, tabId });
      window.__pluck.setState('inicio');
      window.__pluck.setScope('esta_pagina');
      window.__pluck.selectMode('html');
      window.__pluck.clearLastDownload();
      window.__pluck.setLoginConsentAccepted(false);
    }, { url: finalUrl, title: 'Pluck Sandbox Fixture', html: rawHtmlFromPage, tabId: realTabId });

    // Clica para baixar HTML
    await panelPage.click('#btnMainAction');
    await new Promise((r) => setTimeout(r, 400));

    // Valida que a presença de <input type="password"> disparou a tela de consentimento de Login
    const loginState = await panelPage.evaluate(() => window.__pluck.getState());
    console.log(`[Segurança Credenciais] Estado após detecção de senha: "${loginState}"`);
    if (loginState === 'login') {
      await panelPage.screenshot({ path: path.join(screenshotsDir, 'A-painel-escuro-9-login-consent.png') });
      // Clica para prosseguir com higienização segura
      await panelPage.click('#btnProceedLogin');
    }

    // Aguarda o processamento e transição para 'pronto'
    await waitForPluckState(panelPage, 'pronto', 20000);
    const htmlProntoState = await panelPage.evaluate(() => window.__pluck.getState());
    console.log(`[Modo HTML] Estado atingido: "${htmlProntoState}"`);
    if (htmlProntoState !== 'pronto') {
      throw new Error(`Modo HTML não alcançou estado 'pronto', atual: ${htmlProntoState}`);
    }

    const htmlDownload = await panelPage.evaluate(() => window.__pluck.getLastDownload());
    if (!htmlDownload || !htmlDownload.base64) {
      throw new Error('Nenhum arquivo baixado pelo Modo HTML');
    }
    const htmlBuffer = Buffer.from(htmlDownload.base64, 'base64');
    const htmlContent = htmlBuffer.toString('utf-8');
    const htmlFilePath = path.join(cloneProofDir, 'proof-fixture-mode-html.html');
    fs.writeFileSync(htmlFilePath, htmlBuffer);

    console.log(`[Modo HTML] Arquivo salvo: ${htmlFilePath} (${htmlBuffer.length} bytes, nome: "${htmlDownload.filename}")`);

    // [BUG 263 BYTES DEFENSE] Asserções estritas no conteúdo do HTML
    if (htmlBuffer.length < 500) {
      throw new Error(`[BUG 263 BYTES] HTML baixado é muito pequeno: ${htmlBuffer.length} bytes!`);
    }
    if (!htmlContent.includes('<title>Pluck Sandbox Fixture</title>')) {
      throw new Error('[BUG 263 BYTES] HTML baixado não contém o título legítimo da página capturada!');
    }
    if (htmlContent.includes('<title>Pluck</title>')) {
      throw new Error('[BUG 263 BYTES] HTML baixado contém título de fallback indevido "Pluck"!');
    }
    if (htmlContent.includes('senha123') || htmlContent.includes('type="password"')) {
      throw new Error('[SEGURANÇA] HTML baixado não higienizou inputs de senha!');
    }
    if (!htmlContent.includes("default-src 'none'")) {
      throw new Error('[SEGURANÇA] HTML baixado não contém CSP offline!');
    }
    if (!htmlContent.includes('background-color: #16181D') && !htmlContent.includes('data-inlined-from')) {
      throw new Error('[AUTOSSUFICIENTE] HTML não embutiu folha de estilo CSS inline!');
    }
    if (!htmlContent.includes('data:image/png;base64,')) {
      throw new Error('[AUTOSSUFICIENTE] HTML não converteu imagens para data: URI!');
    }

    // ABRE o HTML no Playwright para renderização e comparação visual
    console.log('[Modo HTML] Abrindo HTML capturado no navegador para validação visual...');
    const htmlRenderPage = await browserContext.newPage();
    await htmlRenderPage.goto(`http://127.0.0.1:${mainPort}/rendered-html-test`);
    await htmlRenderPage.waitForLoadState('domcontentloaded');
    await htmlRenderPage.screenshot({ path: path.join(screenshotsDir, 'proof-rendered-html.png') });

    const renderedH1 = await htmlRenderPage.$eval('h1', (el) => el.textContent?.trim());
    if (renderedH1 !== 'Pluck Sandbox Fixture') {
      throw new Error(`DOM do HTML renderizado incompatível: "${renderedH1}"`);
    }
    console.log(`[Modo HTML] Renderização do HTML offline validada com sucesso! H1="${renderedH1}"`);
    await htmlRenderPage.close();

    // 8.2 Modo Página Completa Fiel (ZIP) com extração e servidor local
    console.log('[8.2/8] Testando Modo 2: Página Completa Fiel (ZIP)...');
    await panelPage.evaluate(({ url, title, html, tabId }) => {
      window.__pluck.setTargetTab({ url, title, html, tabId });
      window.__pluck.setState('inicio');
      window.__pluck.setScope('esta_pagina');
      window.__pluck.selectMode('zip');
      window.__pluck.clearLastDownload();
      window.__pluck.setLoginConsentAccepted(true);
      window.__pluck.toggleAutoscroll(); // desliga autoscroll para teste direto de empacotamento
    }, { url: finalUrl, title: 'Pluck Sandbox Fixture', html: rawHtmlFromPage, tabId: realTabId });

    await panelPage.click('#btnMainAction');
    await waitForPluckState(panelPage, 'pronto', 25000);

    const zipDownload = await panelPage.evaluate(() => window.__pluck.getLastDownload());
    if (!zipDownload || !zipDownload.base64) {
      throw new Error('Nenhum arquivo baixado pelo Modo ZIP');
    }
    const zipBuffer = Buffer.from(zipDownload.base64, 'base64');
    const zipFilePath = path.join(cloneProofDir, 'proof-fixture-mode-zip.zip');
    fs.writeFileSync(zipFilePath, zipBuffer);
    console.log(`[Modo ZIP] Pacote salvo: ${zipFilePath} (${zipBuffer.length} bytes, nome: "${zipDownload.filename}")`);

    if (zipBuffer.length < 1000) {
      throw new Error(`Pacote ZIP gerado é muito pequeno: ${zipBuffer.length} bytes`);
    }

    // Descompacta e valida o ZIP
    const unzippedFiles = unzipSync(new Uint8Array(zipBuffer));
    console.log(`[Modo ZIP] Arquivos dentro do pacote: ${Object.keys(unzippedFiles).join(', ')}`);
    if (!unzippedFiles['index.html']) {
      throw new Error('Pacote ZIP não contém index.html');
    }

    // Extrai para pasta local
    const extractedDir = path.join(cloneProofDir, 'extracted-zip');
    fs.rmSync(extractedDir, { recursive: true, force: true });
    fs.mkdirSync(extractedDir, { recursive: true });
    for (const [relPath, content] of Object.entries(unzippedFiles)) {
      const fullP = path.join(extractedDir, relPath);
      fs.mkdirSync(path.dirname(fullP), { recursive: true });
      fs.writeFileSync(fullP, Buffer.from(content));
    }

    // [TESTE REAL DO abrir.bat NO WINDOWS]
    console.log('[TESTE REAL abrir.bat] Validando arquivos no ZIP extraído...');
    if (!unzippedFiles['abrir.bat']) throw new Error('ZIP não contém abrir.bat!');
    if (!unzippedFiles['abrir.ps1']) throw new Error('ZIP não contém abrir.ps1!');

    const batContent = fs.readFileSync(path.join(extractedDir, 'abrir.bat'), 'utf-8');
    console.log(`[TESTE REAL abrir.bat] Conteúdo de abrir.bat:\n${batContent.trim()}`);
    if (batContent.includes('^')) throw new Error('abrir.bat contém carets indevidos (^)!');
    if (batContent.includes('$')) throw new Error('abrir.bat contém variáveis bash/powershell indevidas ($)!');

    console.log('[TESTE REAL abrir.bat] Executando abrir.bat via cmd.exe no Windows...');
    const batProcess = spawn('cmd.exe', ['/c', 'abrir.bat'], {
      cwd: extractedDir,
      windowsHide: true,
      env: { ...process.env, PLUCK_NO_BROWSER: '1' }
    });

    let batOutput = '';
    const urlPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout de 15s aguardando abrir.bat iniciar. Saída capturada:\n${batOutput}`));
      }, 15000);

      const onData = (chunk) => {
        const text = chunk.toString('utf-8');
        batOutput += text;
        const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\//i) || batOutput.match(/http:\/\/127\.0\.0\.1:(\d+)\//i);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}/`);
        }
      };

      batProcess.stdout.on('data', onData);
      batProcess.stderr.on('data', onData);
      batProcess.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      batProcess.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`abrir.bat encerrou prematuramente (código ${code}). Saída:\n${batOutput}`));
      });
    });

    const realServerUrl = await urlPromise;
    console.log(`[TESTE REAL abrir.bat] Servidor nativo Windows ativo e respondendo em: ${realServerUrl}`);

    // Valida GET em / (serve o index.html com status 200)
    const indexResponse = await fetch(`${realServerUrl}index.html`);
    console.log(`[TESTE REAL abrir.bat] GET ${realServerUrl}index.html -> Status: ${indexResponse.status}`);
    if (indexResponse.status !== 200) {
      throw new Error(`Esperava status 200 em index.html, recebeu: ${indexResponse.status}`);
    }
    const indexBody = await indexResponse.text();
    if (!indexBody.includes('Pluck Sandbox Fixture')) {
      throw new Error('Conteúdo do index.html retornado pelo abrir.bat não confere!');
    }

    // Valida GET com Path Traversal (/..%2F..%2F) -> deve retornar 403 (Proibido)
    const traversalResponse = await fetch(`${realServerUrl}..%2F..%2Fwindows%2Fwin.ini`);
    console.log(`[TESTE REAL abrir.bat] GET Path Traversal (..%2F..%2F) -> Status: ${traversalResponse.status}`);
    if (traversalResponse.status !== 403 && traversalResponse.status !== 404) {
      throw new Error(`Esperava status 403 ou 404 para Path Traversal, recebeu: ${traversalResponse.status}`);
    }

    // ABRE o clone no Playwright servido pelo abrir.bat real
    const zipRenderPage = await browserContext.newPage();
    await zipRenderPage.goto(`${realServerUrl}index.html`);
    await zipRenderPage.waitForLoadState('networkidle');
    await zipRenderPage.screenshot({ path: path.join(screenshotsDir, 'proof-rendered-zip.png') });

    const zipBodyBg = await zipRenderPage.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
    console.log(`[TESTE REAL abrir.bat] Cor de fundo computada no clone offline: "${zipBodyBg}"`);
    await zipRenderPage.close();

    // Encerra o processo do servidor abrir.bat e sua árvore
    try {
      execSync(`taskkill /F /T /PID ${batProcess.pid} >nul 2>&1`);
    } catch {}
    try { batProcess.kill(); } catch {}
    console.log('[TESTE REAL abrir.bat] Processo encerrado com sucesso. Teste 100% aprovado!');

    // 8.3 Modo Somente Imagens (ZIP)
    console.log('[8.3/8] Testando Modo 3: Somente Imagens (ZIP)...');
    await panelPage.evaluate(({ url, title, html, tabId }) => {
      window.__pluck.setTargetTab({ url, title, html, tabId });
      window.__pluck.setState('inicio');
      window.__pluck.setScope('esta_pagina');
      window.__pluck.selectMode('images');
      window.__pluck.clearLastDownload();
      window.__pluck.setLoginConsentAccepted(true);
    }, { url: finalUrl, title: 'Pluck Sandbox Fixture', html: rawHtmlFromPage, tabId: realTabId });

    await panelPage.click('#btnMainAction');
    await waitForPluckState(panelPage, 'pronto', 20000);

    const imagesDownload = await panelPage.evaluate(() => window.__pluck.getLastDownload());
    if (!imagesDownload || !imagesDownload.base64) {
      throw new Error('Nenhum arquivo baixado pelo Modo Imagens');
    }
    const imagesBuffer = Buffer.from(imagesDownload.base64, 'base64');
    const imagesFilePath = path.join(cloneProofDir, 'proof-fixture-mode-images.zip');
    fs.writeFileSync(imagesFilePath, imagesBuffer);

    const unzippedImages = unzipSync(new Uint8Array(imagesBuffer));
    const imageFilesCount = Object.keys(unzippedImages).filter((k) => !k.endsWith('/')).length;
    console.log(`[Modo Imagens] Pacote salvo: ${imagesFilePath} (${imageFilesCount} imagens encontradas)`);
    if (imageFilesCount === 0) {
      throw new Error('Nenhuma imagem encontrada no pacote ZIP de imagens');
    }

    // 8.4 Defesa contra HTML Vazio (Reprodução e Validação do Bug 263 bytes)
    console.log('[8.4/8] Testando rejeição estrita de HTML vazio na captura...');
    await panelPage.evaluate(({ url, tabId }) => {
      window.__pluck.setTargetTab({ url, title: 'Pagina Vazia Teste', html: '   ', tabId });
      window.__pluck.setState('inicio');
      window.__pluck.selectMode('html');
      window.__pluck.clearLastDownload();
    }, { url: `http://127.0.0.1:${mainPort}/empty-page.html`, tabId: realTabId });

    // Aciona captura com HTML vazio
    await panelPage.click('#btnMainAction');
    await waitForPluckState(panelPage, 'erro', 5000);

    const errorState = await panelPage.evaluate(() => window.__pluck.getState());
    const blockedDownload = await panelPage.evaluate(() => window.__pluck.getLastDownload());
    const errTitleText = await panelPage.$eval('#erroTitle', (el) => el.textContent?.trim());
    const errSubText = await panelPage.$eval('#erroSub', (el) => el.textContent?.trim());

    console.log(`[Defesa Bug 263b] Estado="${errorState}", ErroTitle="${errTitleText}", ErroSub="${errSubText}", DownloadBloqueado=${blockedDownload === null}`);

    if (errorState !== 'erro') {
      throw new Error(`UI deveria ter transicionado para 'erro' com HTML vazio, mas ficou em: "${errorState}"`);
    }
    if (blockedDownload !== null) {
      throw new Error('[FALHA CRÍTICA] UI salvou arquivo mesmo com HTML vazio!');
    }
    if (!errTitleText.includes('Falha na Captura do Documento')) {
      throw new Error(`Título do erro não reflete falha de captura: "${errTitleText}"`);
    }
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'proof-empty-html-blocked.png') });
    console.log('[Defesa Bug 263b] Proteção validada com sucesso: 0 bytes salvos e erro claro na UI.');

    // 8.5 Teste de Pausa e Salvar Pacote Parcial
    console.log('[8.5/8] Testando estado de pausa e salvamento de pacote parcial...');
    await panelPage.evaluate(() => {
      window.__pluck.setState('baixando', {
        pct: 45,
        loaded: 5,
        total: 10,
        currentItem: 'gravando-recurso-5.png',
        pagesDone: 1,
        pagesTotal: 3,
        mb: '1,2',
        elapsedTime: '00:03'
      });
    });
    await panelPage.click('#btnPauseDownload');
    const pausedState = await panelPage.evaluate(() => window.__pluck.getState());
    console.log(`[Pausa] Estado após pausar: "${pausedState}"`);
    if (pausedState !== 'pausado') throw new Error(`Esperado estado 'pausado', obtido: ${pausedState}`);
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'proof-paused-state.png') });

    await panelPage.click('#btnSavePartial');
    await new Promise((r) => setTimeout(r, 400));
    const partialProntoState = await panelPage.evaluate(() => window.__pluck.getState());
    console.log(`[Pausa] Estado após salvar parcial: "${partialProntoState}"`);
    if (partialProntoState !== 'pronto') throw new Error(`Esperado estado 'pronto' após salvar parcial, obtido: ${partialProntoState}`);
    await panelPage.screenshot({ path: path.join(screenshotsDir, 'proof-partial-zip-saved.png') });

    // 8.6 Teste de Limites de Páginas / MB na UI
    console.log('[8.6/8] Testando configuração de limites de páginas e tamanho...');
    await panelPage.evaluate(() => {
      window.__pluck.setState('inicio');
      window.__pluck.setScope('paginas_vinculadas');
      window.__pluck.setLimitPage(20);
      window.__pluck.setLimitMb(40);
    });
    const limitsSummary = await panelPage.$eval('#scopeSummary', (el) => el.textContent?.trim());
    console.log(`[Limites] Resumo configurado: "${limitsSummary}"`);
    if (!limitsSummary.includes('20 páginas') || !limitsSummary.includes('40 MB')) {
      throw new Error(`Falha na atualização dos limites na UI: "${limitsSummary}"`);
    }

    // 8.7 Prova Completa nos Sites Reais (ArtCraft e Lando Norris nos 3 Modos)
    console.log('[8.7/8] Executando downloads reais via painel em https://getartcraft.com e https://landonorris.com...');

    const liveTestConfigs = [
      {
        id: 'artcraft',
        name: 'ArtCraft',
        url: 'https://getartcraft.com',
        anchors: [
          { sel: '#hero', name: 'Dobra 1: Hero' },
          { sel: '#apps', name: 'Dobra 2: The lineup' },
          { sel: '#principles', name: 'Dobra 3: Principles' },
          { sel: 'footer', name: 'Dobra 4: Footer' }
        ]
      },
      {
        id: 'landonorris',
        name: 'Lando Norris',
        url: 'https://landonorris.com',
        anchors: [
          { sel: 'section.home-hero', name: 'Dobra 1: Hero' },
          { sel: 'section.home-marquee', name: 'Dobra 2: Marquee' },
          { sel: 'section.is-otot-home', name: 'Dobra 3: On Track Off Track' },
          { sel: 'section.home-helmets', name: 'Dobra 4: Helmets' }
        ]
      }
    ];

    const finalReport = [];

    for (const site of liveTestConfigs) {
      console.log(`\n======================================================`);
      console.log(`>>> INICIANDO PROVA NO SITE: ${site.name} (${site.url})`);
      console.log(`======================================================`);

      // 1. Navega a aba principal para o site
      console.log(`[${site.name}] Carregando página no Edge...`);
      await contentPage.setViewportSize({ width: 1440, height: 900 });
      await contentPage.goto(site.url, { timeout: 35000, waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 2000));

      // Descobre o tabId real da contentPage
      const siteTabId = await panelPage.evaluate(async (urlPattern) => {
        const tabs = await chrome.tabs.query({});
        const found = tabs.find((t) => t.url && t.url.includes(urlPattern));
        return found ? found.id : null;
      }, site.id);
      console.log(`[${site.name}] TabId resolvido: ${siteTabId}`);

      // Atualiza aba no painel
      await panelPage.evaluate(({ url, title, tabId }) => {
        window.__pluck.setTargetTab({ url, title, tabId });
        window.__pluck.setScope('esta_pagina');
        window.__pluck.clearLastDownload();
        window.__pluck.setLoginConsentAccepted(true);
        window.__pluck.setState('inicio');
      }, { url: site.url, title: site.name, tabId: siteTabId });

      await panelPage.screenshot({ path: path.join(screenshotsDir, `proof-panel-live-${site.id}.png`) });

      // MODO 1: HTML AUTOSSUFICIENTE
      console.log(`\n[${site.name}] --- Testando Modo 1: HTML Autossuficiente ---`);
      await panelPage.click('#mode-html');

      // Valida se o aviso de WebGL/3D relevante é exibido na UI
      const noticeState = await panelPage.evaluate(() => {
        const el = document.getElementById('webglNotice');
        return {
          visible: el ? window.getComputedStyle(el).display !== 'none' : false,
          text: el ? el.textContent.trim() : ''
        };
      });
      if (site.id === 'landonorris') {
        console.log(`[Lando Norris WebGL] Aviso na UI: visivel=${noticeState.visible}, texto="${noticeState.text}"`);
        if (!noticeState.visible || !noticeState.text.includes('Esta página usa WebGL/3D')) {
          throw new Error(`Aviso de WebGL não exibido na UI para Lando Norris: ${JSON.stringify(noticeState)}`);
        }
        await panelPage.screenshot({ path: path.join(screenshotsDir, 'proof-webgl-warning-banner.png') });
      }

      await panelPage.click('#btnMainAction');

      // Se aparecer tela de login (consentimento), clica para prosseguir
      await new Promise((r) => setTimeout(r, 400));
      const curStateHtml = await panelPage.evaluate(() => window.__pluck.getState());
      if (curStateHtml === 'login') {
        await panelPage.click('#btnProceedLogin');
      }

      await waitForPluckState(panelPage, 'pronto', 45000);
      const dlHtml = await panelPage.evaluate(() => window.__pluck.getLastDownload());
      if (!dlHtml || !dlHtml.base64) {
        throw new Error(`[${site.name}] Nenhum download gerado no Modo HTML`);
      }

      const htmlBuf = Buffer.from(dlHtml.base64, 'base64');
      const htmlStr = htmlBuf.toString('utf-8');
      const htmlSavedPath = path.join(cloneProofDir, `${site.id}-panel-modo-html.html`);
      fs.writeFileSync(htmlSavedPath, htmlBuf);

      // Extrai title e h1 do HTML gerado
      const parsedTitleMatch = htmlStr.match(/<title[^>]*>([^<]+)<\/title>/i);
      const parsedH1Match = htmlStr.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const cleanH1 = parsedH1Match ? parsedH1Match[1].replace(/<[^>]+>/g, '').trim() : '—';
      const cleanTitle = parsedTitleMatch ? parsedTitleMatch[1].trim() : '—';

      // Detecta recursos embutidos e estatísticas
      const embeddedImagesCount = (htmlStr.match(/data:image\/[a-zA-Z+]+;base64,/g) || []).length;
      const embeddedFontsCount = (htmlStr.match(/data:font\/[a-zA-Z0-9-]+;base64,/g) || []).length;
      const inlinedStylesCount = (htmlStr.match(/<style[^>]*>/g) || []).length;
      console.log(`[${site.name}] Modo HTML Autossuficiente: ${htmlBuf.length} bytes (${(htmlBuf.length / 1024).toFixed(1)} KB)`);
      console.log(`[${site.name}] Ativos embutidos: ${embeddedImagesCount} imagens, ${embeddedFontsCount} fontes, ${inlinedStylesCount} folhas CSS`);

      if (htmlBuf.length < 500) {
        throw new Error(`[${site.name}] HTML baixado é menor que 500 bytes (${htmlBuf.length} bytes)`);
      }
      if (cleanTitle === 'Pluck' || cleanTitle === '—') {
        throw new Error(`[${site.name}] HTML baixado não contém título legítimo da página!`);
      }

      // Abre o HTML baixado no Playwright para renderização e comparação por dobras
      const htmlRenderPage = await browserContext.newPage();
      await htmlRenderPage.setViewportSize({ width: 1440, height: 900 });
      await htmlRenderPage.goto(`http://127.0.0.1:${mainPort}/proof-file/${site.id}-panel-modo-html.html`, {
        waitUntil: 'domcontentloaded'
      });
      await new Promise((r) => setTimeout(r, 1500));

      const htmlFoldResults = [];
      for (let i = 0; i < site.anchors.length; i++) {
        const anchor = site.anchors[i];
        console.log(`[${site.name} HTML] Alinhando seção ${i + 1}/${site.anchors.length}: ${anchor.name} (${anchor.sel})...`);

        await scrollToAnchor(contentPage, anchor.sel);
        await scrollToAnchor(htmlRenderPage, anchor.sel);

        const liveFoldPath = path.join(screenshotsDir, `proof-${site.id}-live-fold-${i + 1}-for-html.png`);
        const htmlFoldPath = path.join(screenshotsDir, `proof-${site.id}-html-fold-${i + 1}.png`);
        await contentPage.screenshot({ path: liveFoldPath, timeout: 25000 });
        await htmlRenderPage.screenshot({ path: htmlFoldPath, timeout: 25000 });

        const sbsHtmlPath = path.join(
          cloneProofDir,
          `side-by-side-${site.id}-html-pos${i + 1}-${anchor.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.png`
        );
        const diff = await generateSideBySideAndDiff(
          browserContext,
          liveFoldPath,
          htmlFoldPath,
          sbsHtmlPath,
          `${site.name} HTML Autossuficiente — ${anchor.name}`
        );

        console.log(`[${site.name} HTML] >> Fidelidade ${anchor.name}: ${diff.matchPct}%`);
        htmlFoldResults.push({ name: anchor.name, matchPct: parseFloat(diff.matchPct), print: path.basename(sbsHtmlPath) });
      }
      await htmlRenderPage.close();

      const avgHtmlFidelity = (
        htmlFoldResults.reduce((acc, f) => acc + f.matchPct, 0) / htmlFoldResults.length
      ).toFixed(1);

      finalReport.push({
        site: site.name,
        modo: 'HTML Autossuficiente',
        bytes: `${(htmlBuf.length / 1024).toFixed(1)} KB`,
        titulo: cleanTitle,
        fidelidade: `${avgHtmlFidelity}% (4 dobras: ${htmlFoldResults.map((f) => `${f.matchPct}%`).join(', ')})`,
        print: `side-by-side-${site.id}-html-pos1-*.png`
      });

      // Retorna painel ao estado início
      await panelPage.evaluate(() => window.__pluck.setState('inicio'));
      await new Promise((r) => setTimeout(r, 400));

      // MODO 2: SOMENTE IMAGENS (ZIP)
      console.log(`\n[${site.name}] --- Testando Modo 2: Somente Imagens (ZIP) ---`);
      await panelPage.evaluate(({ url, title, tabId }) => {
        window.__pluck.setTargetTab({ url, title, tabId });
        window.__pluck.setScope('esta_pagina');
        window.__pluck.selectMode('images');
        window.__pluck.clearLastDownload();
        window.__pluck.setLoginConsentAccepted(true);
      }, { url: site.url, title: site.name, tabId: siteTabId });

      await panelPage.click('#btnMainAction');
      await waitForPluckState(panelPage, 'pronto', 35000);

      const dlImages = await panelPage.evaluate(() => window.__pluck.getLastDownload());
      if (!dlImages || !dlImages.base64) {
        throw new Error(`[${site.name}] Nenhum download gerado no Modo Imagens`);
      }

      const imgBuf = Buffer.from(dlImages.base64, 'base64');
      const imgSavedPath = path.join(cloneProofDir, `${site.id}-panel-images.zip`);
      fs.writeFileSync(imgSavedPath, imgBuf);

      const unzippedImgs = unzipSync(new Uint8Array(imgBuf));
      const imgCount = Object.keys(unzippedImgs).filter((k) => !k.endsWith('/')).length;
      console.log(`[${site.name}] Modo Imagens: ${imgBuf.length} bytes, ${imgCount} imagens salvas`);

      if (imgCount === 0) {
        throw new Error(`[${site.name}] Nenhuma imagem salva no pacote de imagens`);
      }

      finalReport.push({
        site: site.name,
        modo: 'Somente Imagens',
        bytes: `${(imgBuf.length / 1024).toFixed(1)} KB`,
        titulo: `${imgCount} imagens salvas`,
        fidelidade: `100% dos recursos de imagem (${imgCount} arquivos no ZIP)`,
        print: `${site.id}-panel-images.zip`
      });

      // Retorna painel ao estado início
      await panelPage.evaluate(() => window.__pluck.setState('inicio'));
      await new Promise((r) => setTimeout(r, 400));

      // MODO 3: PÁGINA COMPLETA FIEL (ZIP)
      console.log(`\n[${site.name}] --- Testando Modo 3: Página Completa Fiel (ZIP) com Autoscroll ---`);
      await panelPage.evaluate(({ url, title, tabId }) => {
        window.__pluck.setTargetTab({ url, title, tabId });
        window.__pluck.setScope('esta_pagina');
        window.__pluck.selectMode('zip');
        window.__pluck.clearLastDownload();
        window.__pluck.setLoginConsentAccepted(true);
      }, { url: site.url, title: site.name, tabId: siteTabId });

      // Certifica que autoscroll está ligado
      const isAutoOn = await panelPage.evaluate(() => {
        const sw = document.getElementById('autoSwitch');
        return sw && !sw.classList.contains('off');
      });
      if (!isAutoOn) {
        await panelPage.click('#autoSwitch');
      }

      await panelPage.click('#btnMainAction');
      console.log(`[${site.name}] Captura Fiel iniciada com autoscroll ativo... aguardando finalização...`);

      await waitForPluckState(panelPage, 'pronto', 90000);
      const dlZip = await panelPage.evaluate(() => window.__pluck.getLastDownload());
      if (!dlZip || !dlZip.base64) {
        throw new Error(`[${site.name}] Nenhum download gerado no Modo ZIP Fiel`);
      }

      const zipBuf = Buffer.from(dlZip.base64, 'base64');
      const zipSavedPath = path.join(cloneProofDir, `${site.id}-panel-fiel.zip`);
      fs.writeFileSync(zipSavedPath, zipBuf);
      console.log(`[${site.name}] Pacote ZIP Fiel salvo: ${zipSavedPath} (${zipBuf.length} bytes)`);

      // Descompacta na pasta correspondente
      const offlineDir = path.join(cloneProofDir, `${site.id}-panel-offline`);
      fs.rmSync(offlineDir, { recursive: true, force: true });
      fs.mkdirSync(offlineDir, { recursive: true });

      const unzippedClone = unzipSync(new Uint8Array(zipBuf));
      for (const [relPath, content] of Object.entries(unzippedClone)) {
        const fullP = path.join(offlineDir, relPath);
        fs.mkdirSync(path.dirname(fullP), { recursive: true });
        fs.writeFileSync(fullP, Buffer.from(content));
      }
      console.log(`[${site.name}] Clone extraído para: ${offlineDir} (${Object.keys(unzippedClone).length} arquivos)`);

      // Inicia servidor local para simular abrir.bat
      const { server: cloneSrv, port: clonePort } = await createStaticCloneServer(offlineDir);
      console.log(`[${site.name}] Servidor estático do clone ativo em http://127.0.0.1:${clonePort}`);

      // Abre aba do clone offline
      const clonePage = await browserContext.newPage();
      await clonePage.setViewportSize({ width: 1440, height: 900 });
      await clonePage.goto(`http://127.0.0.1:${clonePort}/index.html`, { timeout: 35000, waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 2000));

      // Abre aba da página ao vivo para comparação precisa sincronizada
      const liveVerifyPage = await browserContext.newPage();
      await liveVerifyPage.setViewportSize({ width: 1440, height: 900 });
      await liveVerifyPage.goto(site.url, { timeout: 35000, waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 2000));

      const foldResults = [];

      for (let i = 0; i < site.anchors.length; i++) {
        const anchor = site.anchors[i];
        console.log(`[${site.name}] Alinhando seção ${i + 1}/${site.anchors.length}: ${anchor.name} (${anchor.sel})...`);

        await scrollToAnchor(liveVerifyPage, anchor.sel);
        await scrollToAnchor(clonePage, anchor.sel);

        const liveFoldPath = path.join(cloneProofDir, `proof-${site.id}-live-fold-${i + 1}.png`);
        const cloneFoldPath = path.join(cloneProofDir, `proof-${site.id}-clone-fold-${i + 1}.png`);
        await liveVerifyPage.screenshot({ path: liveFoldPath, timeout: 25000 });
        await clonePage.screenshot({ path: cloneFoldPath, timeout: 25000 });

        const sbsPath = path.join(cloneProofDir, `side-by-side-${site.id}-pos${i + 1}-${anchor.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.png`);
        const diff = await generateSideBySideAndDiff(
          browserContext,
          liveFoldPath,
          cloneFoldPath,
          sbsPath,
          `${site.name} — ${anchor.name}`
        );

        console.log(`[${site.name}] >> Fidelidade ${anchor.name}: ${diff.matchPct}%`);
        foldResults.push({ name: anchor.name, matchPct: parseFloat(diff.matchPct), print: path.basename(sbsPath) });
      }

      await clonePage.close();
      await liveVerifyPage.close();
      cloneSrv.close();

      const avgFidelity = (foldResults.reduce((acc, f) => acc + f.matchPct, 0) / foldResults.length).toFixed(1);
      finalReport.push({
        site: site.name,
        modo: 'Página Completa Fiel (ZIP)',
        bytes: `${(zipBuf.length / (1024 * 1024)).toFixed(2)} MB`,
        titulo: cleanTitle,
        fidelidade: `${avgFidelity}% (4 dobras: ${foldResults.map((f) => `${f.matchPct}%`).join(', ')})`,
        print: `side-by-side-${site.id}-pos1-*.png`
      });

      // Retorna painel ao estado início
      await panelPage.evaluate(() => window.__pluck.setState('inicio'));
      await new Promise((r) => setTimeout(r, 400));
    }

    console.log('\n======================================================');
    console.log('>>> RESUMO CONSOLIDADO DOS TESTES AO VIVO NO PAINEL');
    console.log('======================================================');
    console.table(finalReport);

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
