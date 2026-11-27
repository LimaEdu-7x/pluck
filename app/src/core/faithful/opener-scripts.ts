// Utilitários para gerar scripts de abertura local e README offline dentro do pacote ZIP

export function generateReadmeText(siteTitle: string, siteUrl: string): string {
  return `========================================================================
CLONE FIEL OFFLINE — ${siteTitle.toUpperCase()}
Origem: ${siteUrl}
Gerado com: Pluck v0.6.0 (Extrator Web 100% Local)
========================================================================

COMO VISUALIZAR ESTE CLONE COM FIDELIDADE TOTAL:

1. POR QUE NÃO DAR DUPLO CLIQUE DIRETAMENTE EM "index.html" (file://)?
   Navegadores modernos (Edge, Chrome, Firefox, Safari) bloqueiam módulos
   JavaScript (<script type="module">), fontes tipográficas (WOFF2) e
   requisições assíncronas por padrão de segurança ao rodar sob o protocolo
   file:// (erro de CORS: "URL scheme must be http or https").
   Se aberto com duplo clique direto, o site pode perder animações,
   interações e fontes.

2. COMO ABRIR NO WINDOWS:
   Dê um duplo clique no arquivo:
   -> "abrir.bat"
   Ele inicia um servidor local ultraleve nativo do próprio Windows vinculado
   estritamente ao loopback 127.0.0.1 em uma porta dinâmica não reservada (sem
   precisar instalar Python, Node.js ou qualquer programa) e abre a página
   no seu navegador padrão.

3. COMO ABRIR NO MAC OU LINUX:
   Abra o terminal nesta pasta e execute:
   -> "sh abrir.sh"
   Ele inicia um servidor HTTP local vinculado a 127.0.0.1 em uma porta dinâmica livre.

4. NAVEGAÇÃO ENTRE PÁGINAS E ROTAS:
   Se este pacote foi gerado no modo "Esta página", subpáginas não capturadas
   exibirão uma página de aviso orientando a captura nos modos "Páginas vinculadas"
   ou "Site inteiro". Nos modos vinculados ou site inteiro, todas as páginas
   capturadas podem ser navegadas normalmente com todas as animações preservadas.

5. PRIVACIDADE E SEGURANÇA:
   Este clone contém uma política de segurança (Content-Security-Policy)
   que neutraliza qualquer chamada de telemetria externa, rastreadores ou
   comunicação com servidores remotos. O servidor local vincula-se apenas ao
   endereço loopback 127.0.0.1 e restringe requisições estritamente aos
   arquivos contidos na pasta deste clone. Todo o processamento é 100% local.
========================================================================
`;
}

export function generateAbrirBat(): string {
  return `@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0abrir.ps1"
`;
}

export function generateAbrirPs1(): string {
  return `# Servidor HTTP Local Ultraleve e Seguro do Pluck para Clone Fiel
$baseDir = $PSScriptRoot
if (-not $baseDir) {
  $baseDir = (Get-Location).Path
}
$baseDir = [System.IO.Path]::GetFullPath($baseDir)

# Porta dinamica livre vinculada estritamente a 127.0.0.1 (FIEL-01 / FIEL-07)
$tcp = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse('127.0.0.1'), 0)
$tcp.Start()
$port = $tcp.LocalEndpoint.Port
$tcp.Stop()

$script:listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$port/"
$script:listener.Prefixes.Add($prefix)
$script:listener.Start()
$listener = $script:listener

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "Pluck - Servidor Local para Clone Fiel" -ForegroundColor Cyan
Write-Host "Servidor ativo em http://127.0.0.1:$port/" -ForegroundColor Green
Write-Host "Vinculado exclusivamente a 127.0.0.1 (sem exposicao na rede)" -ForegroundColor Gray
Write-Host "Diretorio: $baseDir" -ForegroundColor Gray
Write-Host "Pressione Ctrl+C para encerrar quando terminar." -ForegroundColor Yellow
Write-Host "===================================================" -ForegroundColor Cyan

if (-not $env:PLUCK_NO_BROWSER) {
  Start-Process "http://127.0.0.1:$port/index.html"
}

$mimeTypes = @{
  '.html'  = 'text/html; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.js'    = 'application/javascript; charset=utf-8'
  '.mjs'   = 'application/javascript; charset=utf-8'
  '.json'  = 'application/json; charset=utf-8'
  '.txt'   = 'text/plain; charset=utf-8'
  '.png'   = 'image/png'
  '.jpg'   = 'image/jpeg'
  '.jpeg'  = 'image/jpeg'
  '.webp'  = 'image/webp'
  '.gif'   = 'image/gif'
  '.svg'   = 'image/svg+xml'
  '.woff'  = 'font/woff'
  '.woff2' = 'font/woff2'
  '.ttf'   = 'font/ttf'
  '.wasm'  = 'application/wasm'
  '.glb'   = 'model/gltf-binary'
  '.gltf'  = 'model/gltf+json'
  '.riv'   = 'application/octet-stream'
  '.hdr'   = 'application/octet-stream'
  '.mp4'   = 'video/mp4'
  '.webm'  = 'video/webm'
}

# Deteccao de processo pai para evitar processo orfao se a janela cmd for fechada no X ou receber taskkill
$parentDetectorCode = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class ParentDetector {
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public UIntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength);

    public static int GetParentPid(int pid) {
        try {
            using (var proc = Process.GetProcessById(pid)) {
                var pbi = new PROCESS_BASIC_INFORMATION();
                int returnLength;
                int status = NtQueryInformationProcess(proc.Handle, 0, ref pbi, Marshal.SizeOf(pbi), out returnLength);
                if (status == 0) {
                    return pbi.InheritedFromUniqueProcessId.ToInt32();
                }
            }
        } catch {}
        return 0;
    }
}
"@
Add-Type -TypeDefinition $parentDetectorCode -ErrorAction SilentlyContinue

$script:parentProcess = $null
try {
  $pPid = [ParentDetector]::GetParentPid($PID)
  if ($pPid -gt 0) {
    $parentCandidate = [System.Diagnostics.Process]::GetProcessById($pPid)
    if ($parentCandidate.ProcessName -eq 'cmd' -and $parentCandidate.StartTime -le (Get-Process -Id $PID).StartTime) {
      $script:parentProcess = $parentCandidate
    }
  }
} catch {}

function Stop-PluckServer {
  if ($script:listener) {
    try {
      if ($script:listener.IsListening) { $script:listener.Stop() }
      $script:listener.Close()
      $script:listener = $null
    } catch {}
  }
}

# 1. Trata fechamento de processo (ProcessExit) garantindo liberacao da porta
[System.AppDomain]::CurrentDomain.add_ProcessExit({
  Stop-PluckServer
})

# 2. Tratamento gracioso e instantaneo de interrupcao por Ctrl+C (< 2s)
$script:running = $true
$cancelHandler = [ConsoleCancelEventHandler]{
  param($sender, $e)
  $e.Cancel = $true
  Write-Host "\`nCtrl+C recebido. Encerrando servidor e liberando porta..." -ForegroundColor Yellow
  Stop-PluckServer
  if ($script:parentProcess) {
    try {
      if (-not $script:parentProcess.HasExited -and $script:parentProcess.ProcessName -eq 'cmd') {
        $script:parentProcess.Kill()
      }
    } catch {}
  }
  [System.Diagnostics.Process]::GetCurrentProcess().Kill()
}
try { [Console]::add_CancelKeyPress($cancelHandler) } catch {}

$contextTask = $null

try {
  while ($script:running -and $script:listener -and $script:listener.IsListening) {
    # Monitora processo pai a cada iteracao: se o cmd.exe foi fechado (no 'X' ou taskkill), encerra sem orfao
    if ($script:parentProcess) {
      $parentDead = $false
      try {
        $script:parentProcess.Refresh()
        if ($script:parentProcess.HasExited) { $parentDead = $true }
      } catch {
        $parentDead = $true
      }
      if ($parentDead) {
        Stop-PluckServer
        [System.Diagnostics.Process]::GetCurrentProcess().Kill()
      }
    }

    if ($null -eq $contextTask) {
      $contextTask = $script:listener.GetContextAsync()
    }

    # Aguarda com polling curto de 500 ms permitindo resposta imediata ao Ctrl+C e deteccao de pai
    if (-not $contextTask.Wait(500)) {
      continue
    }

    $ctx = $contextTask.Result
    $contextTask = $null

    $req = $ctx.Request
    $res = $ctx.Response

    try {
      # Sem CORS aberto (FIEL-01)
      $rawPath = $req.Url.LocalPath.TrimStart('/')
      if (-not $rawPath -or $rawPath -eq '/') {
        $rawPath = 'index.html'
      }
      $decoded = [System.Uri]::UnescapeDataString($rawPath)
      $targetPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($baseDir, $decoded))

      # Prevenção rigorosa de Path Traversal (FIEL-01)
      if (-not $targetPath.StartsWith($baseDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403
        $msg = [System.Text.Encoding]::UTF8.GetBytes("403 Proibido: Acesso fora do diretorio do clone")
        $res.OutputStream.Write($msg, 0, $msg.Length)
        continue
      }

      # 0. Neutraliza requisições de prefetch RSC do Next.js (evita 404 no console)
      $isRsc = $req.Url.Query.Contains('_rsc=') -or $rawPath.Contains('__next._tree.txt') -or $rawPath.Contains('/_next/data/') -or ($req.Headers['RSC']) -or ($req.Headers['Next-Router-Prefetch'])
      if ($isRsc) {
        $res.ContentType = 'text/x-component; charset=utf-8'
        $res.StatusCode = 200
        $bytes = [byte[]]@()
        $res.OutputStream.Write($bytes, 0, 0)
        continue
      }

      $resolvedFile = $null

      # 1. Arquivo direto
      if ([System.IO.File]::Exists($targetPath)) {
        $resolvedFile = $targetPath
      }
      # 2. Rota limpa com extensao .html (ex: /apps/figcraft -> apps/figcraft.html)
      elseif ([System.IO.File]::Exists("$targetPath.html")) {
        $resolvedFile = "$targetPath.html"
      }
      # 3. Rota de diretorio com index.html (ex: /apps/ -> apps/index.html)
      elseif ([System.IO.File]::Exists([System.IO.Path]::Combine($targetPath, "index.html"))) {
        $resolvedFile = [System.IO.Path]::Combine($targetPath, "index.html")
      }
      # 4. Compatibilidade Next.js: _next <-> next
      elseif ($targetPath.Contains('_next')) {
        $alt = $targetPath.Replace('_next', 'next')
        if ([System.IO.File]::Exists($alt)) { $resolvedFile = $alt }
      }
      elseif ($targetPath.Contains('\\\\next\\\\') -or $targetPath.Contains('/next/')) {
        $alt = $targetPath.Replace('\\\\next\\\\', '\\\\_next\\\\').Replace('/next/', '/_next/')
        if ([System.IO.File]::Exists($alt)) { $resolvedFile = $alt }
      }

      if ($resolvedFile) {
        $ext = [System.IO.Path]::GetExtension($resolvedFile).ToLower()
        $res.ContentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { 'application/octet-stream' }
        $res.StatusCode = 200
        $bytes = [System.IO.File]::ReadAllBytes($resolvedFile)
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        # Fallback offline para rotas/navegacao HTML nao capturadas (NUNCA tela em branco)
        $fallbackPath = [System.IO.Path]::Combine($baseDir, "offline-fallback.html")
        if ([System.IO.File]::Exists($fallbackPath) -and ($rawPath.EndsWith('.html') -or (-not [System.IO.Path]::HasExtension($rawPath)))) {
          $res.ContentType = 'text/html; charset=utf-8'
          $res.StatusCode = 200
          $bytes = [System.IO.File]::ReadAllBytes($fallbackPath)
          $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
          $res.StatusCode = 404
          $err = [System.Text.Encoding]::UTF8.GetBytes("404 Nao Encontrado: $rawPath")
          $res.OutputStream.Write($err, 0, $err.Length)
        }
      }
    } catch {
      # Falhas pontuais no socket ou cancelamento pelo cliente nao derrubam o servidor
    } finally {
      try { $res.OutputStream.Close() } catch {}
    }
  }
} catch {
  # Interrupcao ou encerramento
} finally {
  try { [Console]::remove_CancelKeyPress($cancelHandler) } catch {}
  if ($listener) {
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
  }
  Write-Host "Servidor encerrado e porta liberada." -ForegroundColor Green
}
`;
}

export function generateAbrirSh(): string {
  return `#!/bin/sh
echo "Iniciando servidor local do Pluck vinculado a 127.0.0.1..."
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()" 2>/dev/null || echo 8080)
if command -v python3 >/dev/null 2>&1; then
    python3 -c "import http.server, socketserver, os, sys
port = int(sys.argv[1])
class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = super().translate_path(path)
        if not os.path.exists(p):
            if os.path.exists(p + '.html'): return p + '.html'
            if '/_next/' in path and os.path.exists(p.replace('/_next/', '/next/')): return p.replace('/_next/', '/next/')
            if '/next/' in path and os.path.exists(p.replace('/next/', '/_next/')): return p.replace('/next/', '/_next/')
            fb = os.path.join(os.getcwd(), 'offline-fallback.html')
            if os.path.exists(fb) and (path.endswith('.html') or '.' not in os.path.basename(path)): return fb
        return p
    def do_GET(self):
        if '_rsc=' in self.path or '__next._tree.txt' in self.path or self.headers.get('RSC') or self.headers.get('Next-Router-Prefetch'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/x-component; charset=utf-8')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        return super().do_GET()
with socketserver.TCPServer(('127.0.0.1', port), Handler) as httpd:
    httpd.serve_forever()" "$PORT" &
elif command -v python >/dev/null 2>&1; then
    python -m SimpleHTTPServer "$PORT" &
elif command -v npx >/dev/null 2>&1; then
    npx serve -l "$PORT" . &
else
    echo "Erro: Python ou Node.js necessário para abrir no Linux/macOS."
    exit 1
fi

sleep 1
URL="http://127.0.0.1:$PORT/index.html"
if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
elif command -v open >/dev/null 2>&1; then
    open "$URL"
else
    echo "Abra $URL no seu navegador."
fi
`;
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function generateOfflineFallbackHtml(siteTitle: string, siteUrl: string): string {
  const safeTitle = escapeHtml(siteTitle || 'Página');
  const safeUrl = escapeHtml(siteUrl || '');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none';">
  <title>Página não capturada — Pluck Offline</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #12151f;
      --border: #23283b;
      --text: #f0f3fa;
      --muted: #8b95a8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --badge-bg: rgba(59, 130, 246, 0.15);
      --badge-text: #60a5fa;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card-bg: #ffffff;
        --border: #e2e8f0;
        --text: #0f172a;
        --muted: #64748b;
        --accent: #2563eb;
        --accent-hover: #1d4ed8;
        --badge-bg: rgba(37, 99, 235, 0.1);
        --badge-text: #2563eb;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 40px 32px;
      max-width: 540px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--badge-bg);
      color: var(--badge-text);
      font-size: 12px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 9999px;
      margin-bottom: 20px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 12px;
      line-height: 1.3;
    }
    p {
      color: var(--muted);
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .notice-box {
      background: rgba(0, 0, 0, 0.2);
      border: 1px dashed var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 28px;
      font-size: 13.5px;
      color: var(--muted);
      text-align: left;
      line-height: 1.5;
    }
    .notice-box strong { color: var(--text); }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--accent);
      color: #ffffff;
      font-weight: 600;
      font-size: 14px;
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      transition: background 0.15s ease;
      cursor: pointer;
    }
    .btn:hover {
      background: var(--accent-hover);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="pill"><span class="dot"></span> Pluck · Navegação Offline</div>
    <h1>Página não capturada neste pacote</h1>
    <p>Esta subpágina ou rota de <strong>${safeTitle}</strong> (${safeUrl}) não está disponível neste pacote porque a captura foi realizada no modo <strong>Esta página</strong>.</p>
    <div class="notice-box">
      <strong>Como navegar em todas as páginas deste site?</strong><br>
      Para navegar entre todas as páginas internas (como <em>FigCraft</em>, <em>EffectCraft</em>, <em>WordCraft</em>, <em>Lineup</em> e demais ferramentas) com 100% de fidelidade e todas as animações preservadas, realize a captura no Pluck utilizando o escopo <strong>Páginas vinculadas</strong> ou <strong>Site inteiro</strong>.
    </div>
    <a href="index.html" class="btn">← Voltar para a Página Principal</a>
  </div>
</body>
</html>
`;
}
