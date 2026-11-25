import { describe, it, expect } from 'vitest';
import {
  generateAbrirBat,
  generateAbrirPs1,
  generateAbrirSh,
  generateReadmeText,
  generateOfflineFallbackHtml
} from './opener-scripts';

describe('Opener Scripts Security and Navigation (FIEL-01, FIEL-07 & Multi-Page)', () => {
  it('abrir.bat é limpo (2 linhas), sem carets ^, sem $ e chama abrir.ps1 diretamente no mesmo console', () => {
    const bat = generateAbrirBat();
    expect(bat).not.toContain('^');
    expect(bat).not.toContain('$');
    expect(bat).toContain('abrir.ps1');
    expect(bat).toContain('@echo off');
    expect(bat).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0abrir.ps1"');
    expect(bat).not.toContain('start ""');
  });

  it('abrir.ps1 não contém Access-Control-Allow-Origin: * (FIEL-01)', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).not.toContain("Access-Control-Allow-Origin', '*'");
    expect(ps1).not.toContain('Access-Control-Allow-Origin: *');
  });

  it('abrir.ps1 valida caminho canônico com .StartsWith($baseDir) para prevenir Path Traversal (FIEL-01)', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('$targetPath.StartsWith($baseDir');
    expect(ps1).toContain('403');
  });

  it('abrir.ps1 vincula-se exclusivamente a 127.0.0.1 e usa porta dinâmica livre (FIEL-01 & FIEL-07)', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('127.0.0.1');
    expect(ps1).toContain('TcpListener');
    expect(ps1).toContain('$tcp.LocalEndpoint.Port');
    expect(ps1).not.toContain('$port = 8080');
  });

  it('abrir.ps1 usa GetContextAsync com polling de 500ms e CancelKeyPress para resposta imediata ao Ctrl+C e mata cmd pai para evitar prompt S/N', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('GetContextAsync()');
    expect(ps1).toContain('$contextTask.Wait(500)');
    expect(ps1).toContain('ConsoleCancelEventHandler');
    expect(ps1).toContain('$e.Cancel = $true');
    expect(ps1).toContain('$script:parentProcess.Kill()');
    expect(ps1).toContain('[System.Diagnostics.Process]::GetCurrentProcess().Kill()');
    expect(ps1).toContain('Pressione Ctrl+C para encerrar quando terminar.');
    expect(ps1).toContain('Stop-PluckServer');
  });

  it('abrir.ps1 previne PID reciclado: só guarda parentProcess se ProcessName for cmd e StartTime for anterior ou igual ao StartTime do PID atual', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain("$parentCandidate.ProcessName -eq 'cmd'");
    expect(ps1).toContain('$parentCandidate.StartTime -le (Get-Process -Id $PID).StartTime');
    expect(ps1).toContain('$script:parentProcess = $parentCandidate');
  });

  it('abrir.ps1 só executa loop de HasExited e finalização se parentProcess for cmd válido (não derruba Pluck em outros launchers)', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('if ($script:parentProcess) {');
    expect(ps1).toContain('$script:parentProcess.Refresh()');
    expect(ps1).toContain('if ($script:parentProcess.HasExited) { $parentDead = $true }');
  });

  it('abrir.ps1 monitora processo pai e registra ProcessExit para evitar processo órfão e liberar porta', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('ParentDetector');
    expect(ps1).toContain('NtQueryInformationProcess');
    expect(ps1).toContain('$script:parentProcess');
    expect(ps1).toContain('add_ProcessExit');
    expect(ps1).toContain('Stop-PluckServer');
    expect(ps1).toContain('GetCurrentProcess().Kill()');
  });

  it('abrir.ps1 suporta rotas limpas sem .html, _next e fallback offline amigável (nunca tela em branco)', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('"$targetPath.html"');
    expect(ps1).toContain('Combine($targetPath, "index.html")');
    expect(ps1).toContain("Replace('_next', 'next')");
    expect(ps1).toContain('offline-fallback.html');
  });

  it('abrir.ps1 e abrir.sh neutralizam requisições de prefetch RSC do Next.js com 200 text/x-component', () => {
    const ps1 = generateAbrirPs1();
    expect(ps1).toContain('_rsc=');
    expect(ps1).toContain('__next._tree.txt');
    expect(ps1).toContain('text/x-component; charset=utf-8');

    const sh = generateAbrirSh();
    expect(sh).toContain('_rsc=');
    expect(sh).toContain('__next._tree.txt');
    expect(sh).toContain('text/x-component; charset=utf-8');
  });

  it('abrir.sh vincula-se a 127.0.0.1 e suporta fallback offline', () => {
    const sh = generateAbrirSh();
    expect(sh).toContain('127.0.0.1');
    expect(sh).toContain('offline-fallback.html');
  });

  it('generateOfflineFallbackHtml gera documento HTML válido e amigável orientando uso de Páginas vinculadas / Site inteiro', () => {
    const fallback = generateOfflineFallbackHtml('ArtCraft', 'https://getartcraft.com');
    expect(fallback).toContain('<!DOCTYPE html>');
    expect(fallback).toContain('Página não capturada neste pacote');
    expect(fallback).toContain('Esta página');
    expect(fallback).toContain('Páginas vinculadas');
    expect(fallback).toContain('Site inteiro');
    expect(fallback).toContain('href="index.html"');
  });

  it('generateOfflineFallbackHtml escapa siteTitle e siteUrl contra injeção de HTML/XSS (dados de terceiros)', () => {
    const maliciousTitle = 'ArtCraft <script>alert("xss")</script> & "Evil" \'Title\'';
    const maliciousUrl = 'https://getartcraft.com/<svg onload=alert(1)>&q="xss"';
    const fallback = generateOfflineFallbackHtml(maliciousTitle, maliciousUrl);

    expect(fallback).not.toContain('<script>alert("xss")</script>');
    expect(fallback).not.toContain('<svg onload=alert(1)>');
    expect(fallback).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(fallback).toContain('&lt;svg onload=alert(1)&gt;');
    expect(fallback).toContain('&amp;');
  });

  it('generateOfflineFallbackHtml inclui meta CSP restritiva sem scripts externos', () => {
    const fallback = generateOfflineFallbackHtml('ArtCraft', 'https://getartcraft.com');
    expect(fallback).toContain('Content-Security-Policy');
    expect(fallback).toContain("default-src 'none'");
    expect(fallback).toContain("style-src 'unsafe-inline'");
    expect(fallback).not.toContain('script-src *');
    expect(fallback).not.toContain("script-src 'unsafe-inline'");
  });

  it('README.txt documenta isolamento em 127.0.0.1 e orientações de navegação offline', () => {
    const readme = generateReadmeText('Site Teste', 'https://teste.com');
    expect(readme).toContain('127.0.0.1');
    expect(readme).toContain('Esta página');
    expect(readme).toContain('Site inteiro');
  });
});
