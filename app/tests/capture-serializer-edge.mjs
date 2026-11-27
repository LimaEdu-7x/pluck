// Prova no Edge real: serializeLiveDom injetado por chrome.scripting.executeScript com func direto
// (sem string no alvo) gera o mesmo HTML da linha de base antiga, e o modo capture congela o estado.
// Sandbox: perfil descartavel, fixture local em 127.0.0.1. Nunca usa o perfil real.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const distPath = path.join(appDir, 'dist');
const samplesDir = path.resolve(appDir, '..', 'pesquisa', 'amostras');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pluck-serializer-'));
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const FIXTURE = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Captura Pluck</title>
<style>body{margin:0;font-family:sans-serif;background:#16181D;color:#fff;width:1280px;height:960px}
h1{padding:40px 40px 0}canvas{display:block;position:absolute;left:40px;top:220px}</style></head>
<body><h1>Pagina de captura</h1>
<div data-reveal style="opacity: 0; padding: 20px 40px; font-size: 32px">Texto revelado pelo modo HTML</div>
<canvas id="c" width="400" height="300"></canvas>
<script>const x=document.getElementById('c').getContext('2d');x.fillStyle='#FF6B3D';x.fillRect(0,0,400,300);x.fillStyle='#FFFFFF';x.beginPath();x.arc(200,150,90,0,7);x.fill();</script>
</body></html>`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failures++;
}

// 1. Compila o serializador real (mesmo codigo do app) e pega o fonte da funcao exportada
const bundle = path.join(scratch, 'dom-serializer.mjs');
await build({
  entryPoints: [path.join(appDir, 'src/core/faithful/dom-serializer.ts')],
  bundle: true, format: 'esm', outfile: bundle, platform: 'browser', logLevel: 'silent'
});
const { serializeLiveDom } = await import(pathToFileURL(bundle).href);
const src = serializeLiveDom.toString();
check('fonte de serializeLiveDom obtido', src.startsWith('function') || src.includes('=>') || src.length > 500, `${src.length} caracteres`);

// 2. Servidor local da fixture
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/fixture-captura.html`;

// 3. Edge com a extensao, perfil descartavel
const tmpProfile = path.join(scratch, 'profile');
fs.mkdirSync(tmpProfile, { recursive: true });
let ctx;
try {
  ctx = await chromium.launchPersistentContext(tmpProfile, {
    executablePath: edgePath,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, '--no-first-run', '--no-default-browser-check']
  });

  let sw = null;
  for (let i = 0; i < 30 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes('background.js')) || null;
    if (!sw) await new Promise((r) => setTimeout(r, 300));
  }
  check('service worker da extensao ativo no Edge', !!sw);

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto(url);
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
  const liveBefore = await page.evaluate(() => ({
    opacity: document.querySelector('[data-reveal]').style.opacity,
    canvasDisplay: document.querySelector('canvas').style.display
  }));
  const shotLive = await page.screenshot({ type: 'png' });

  // Descobre o tabId da fixture a partir do service worker
  const tabId = await sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u);
    return t ? t.id : null;
  }, url);
  check('aba da fixture encontrada', typeof tabId === 'number', `tabId ${tabId}`);

  // 4. Injecao via executeScript: func direto (funcao criada a partir do fonte, sem string no alvo)
  //    A linha de base reproduz o padrao antigo do painel: a string entra como argumento e roda com new Function.
  const run = (opts) => sw.evaluate(async ({ tabId, src, opts }) => {
    const serializeFn = (0, eval)('(' + src + ')'); // so o harness do teste; o app nao faz isso
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: serializeFn,
      args: opts === undefined ? [] : [null, opts]
    });
    return result;
  }, { tabId, src, opts });

  const baseline = await sw.evaluate(async ({ tabId, src }) => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (s) => {
        try {
          const fn = new Function('return (' + s + ')()');
          const out = fn();
          if (out && out.length > 50) return out;
        } catch {}
        return document.documentElement.outerHTML;
      },
      args: [src]
    });
    return result;
  }, { tabId, src });

  const plain = await run(undefined);
  check('HTML gerado sem capture', typeof plain === 'string' && plain.length > 50, `${plain.length} caracteres`);
  // Medicao (nao e regressao): no Edge o new Function do padrao antigo lanca erro, e o painel cai no outerHTML
  const oldPathFellBack = baseline === (await page.evaluate(() => document.documentElement.outerHTML));
  check('MEDIDO: padrao antigo (string + new Function) cai no outerHTML no Edge', oldPathFellBack, `baseline ${baseline.length} caracteres`);
  check('novo caminho usa o serializador (com carimbo de origem)', plain !== baseline && plain.includes('<!--pluck-source-origin:http://127.0.0.1:'));

  const frozen = await run({ capture: { freeze: true, canvasSnapshots: [] } });
  check('modo HTML gera HTML', typeof frozen === 'string' && frozen.length > 50, `${frozen.length} caracteres`);
  check('canvas virou imagem no HTML capturado', frozen.includes('data-pluck-canvas-img="true"'));
  check('elemento animado aparece revelado no HTML', frozen.includes('opacity: 1') && !frozen.includes('opacity: 0'));
  check('texto revelado presente no HTML', frozen.includes('Texto revelado pelo modo HTML'));

  const liveAfter = await page.evaluate(() => ({
    imgs: document.querySelectorAll('[data-pluck-canvas-img]').length,
    canvasDisplay: document.querySelector('canvas').style.display
  }));
  check('DOM vivo sem a imagem temporaria', liveAfter.imgs === 0, `imagens restantes ${liveAfter.imgs}`);
  check('canvas visivel de novo na aba', liveAfter.canvasDisplay === '' && liveBefore.canvasDisplay === '', `display "${liveAfter.canvasDisplay}"`);

  // 5. Amostra lado a lado: esquerda = aba viva antes da captura; direita = HTML capturado renderizado
  const capturePage = await ctx.newPage();
  await capturePage.setViewportSize({ width: 1280, height: 960 });
  await capturePage.setContent(frozen, { waitUntil: 'load' });
  await capturePage.waitForTimeout(300);
  const shotCapture = await capturePage.screenshot({ type: 'png' });

  const compose = await ctx.newPage();
  await compose.setViewportSize({ width: 2560, height: 960 });
  const b64 = (buf) => buf.toString('base64');
  await compose.setContent(`<!DOCTYPE html><html><body style="margin:0;display:flex;background:#000">
    <div style="width:1280px;height:960px;position:relative"><img src="data:image/png;base64,${b64(shotLive)}" style="width:1280px;height:960px;display:block"><span style="position:absolute;left:16px;top:12px;color:#fff;background:#000;font:600 20px sans-serif;padding:4px 10px">ANTES: aba viva</span></div>
    <div style="width:1280px;height:960px;position:relative"><img src="data:image/png;base64,${b64(shotCapture)}" style="width:1280px;height:960px;display:block"><span style="position:absolute;left:16px;top:12px;color:#fff;background:#000;font:600 20px sans-serif;padding:4px 10px">DEPOIS: HTML capturado</span></div>
  </body></html>`);
  fs.mkdirSync(samplesDir, { recursive: true });
  const outPng = path.join(samplesDir, 'captura-serializer-lado-a-lado.png');
  await compose.screenshot({ path: outPng, type: 'png', fullPage: false });
  check('PNG lado a lado 2560x960 gravado', fs.existsSync(outPng), outPng);

  await ctx.close();
} finally {
  if (ctx) await ctx.close().catch(() => {});
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? 'RESULTADO: todas as checagens passaram' : `RESULTADO: ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
