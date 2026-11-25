// Utilitários para gerar scripts de abertura local e README offline dentro do pacote ZIP

export function generateReadmeText(siteTitle: string, siteUrl: string): string {
  return `========================================================================
CLONE FIEL OFFLINE — ${siteTitle.toUpperCase()}
Origem: ${siteUrl}
Gerado com: Pluck v0.1 (Extrator Web 100% Local)
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

4. PRIVACIDADE E SEGURANÇA:
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
pause
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

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "Pluck - Servidor Local para Clone Fiel" -ForegroundColor Cyan
Write-Host "Servidor ativo em http://127.0.0.1:$port/" -ForegroundColor Green
Write-Host "Vinculado exclusivamente a 127.0.0.1 (sem exposicao na rede)" -ForegroundColor Gray
Write-Host "Diretorio: $baseDir" -ForegroundColor Gray
Write-Host "Pressione Ctrl+C para encerrar quando terminar." -ForegroundColor Gray
Write-Host "===================================================" -ForegroundColor Cyan

Start-Process "http://127.0.0.1:$port/index.html"

$mimeTypes = @{
  '.html'  = 'text/html; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.js'    = 'application/javascript; charset=utf-8'
  '.mjs'   = 'application/javascript; charset=utf-8'
  '.json'  = 'application/json; charset=utf-8'
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

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

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
      $res.OutputStream.Close()
      continue
    }

    if ([System.IO.File]::Exists($targetPath)) {
      $ext = [System.IO.Path]::GetExtension($targetPath).ToLower()
      $res.ContentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { 'application/octet-stream' }
      $res.StatusCode = 200
      $bytes = [System.IO.File]::ReadAllBytes($targetPath)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $err = [System.Text.Encoding]::UTF8.GetBytes("404 Nao Encontrado")
      $res.OutputStream.Write($err, 0, $err.Length)
    }
    $res.OutputStream.Close()
  }
} finally {
  if ($listener -and $listener.IsListening) {
    $listener.Stop()
    $listener.Close()
  }
}
`;
}

export function generateAbrirSh(): string {
  return `#!/bin/sh
echo "Iniciando servidor local do Pluck vinculado a 127.0.0.1..."
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()" 2>/dev/null || echo 8080)
if command -v python3 >/dev/null 2>&1; then
    python3 -m http.server "$PORT" --bind 127.0.0.1 &
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
