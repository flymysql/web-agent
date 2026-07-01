# Starts SSH tunnel + local Host-rewrite proxy (two windows).
# Usage: .\scripts\astra-tunnel\start-all.ps1
#
# If you see EADDRINUSE on :15723, run stop-all.ps1 first (or the proxy is already up — just use it).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')

function Test-PortListening($port) {
  return [bool](netstat -ano | Select-String "LISTENING" | Select-String ":$port\s")
}

$proxyUp = Test-PortListening 15723
$tunnelUp = Test-PortListening 15722

if ($proxyUp -and $tunnelUp) {
  Write-Host "Astra tunnel (:15722) and proxy (:15723) already running — nothing to start." -ForegroundColor Green
  Write-Host "LLM_BASE_URL=http://127.0.0.1:15723/astra-llm/v1" -ForegroundColor Green
  exit 0
}

if ($proxyUp -or $tunnelUp) {
  Write-Host "Partially running (tunnel=$tunnelUp proxy=$proxyUp). Cleaning up first..." -ForegroundColor Yellow
  & (Join-Path $here 'stop-all.ps1')
  Start-Sleep -Seconds 1
}

Write-Host "Starting Astra SSH tunnel in a new window..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'start-tunnel.ps1')
)

Start-Sleep -Seconds 2

Write-Host "Starting local proxy (Host rewrite for Node fetch)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command',
  "cd '$root'; node scripts/astra-tunnel/local-proxy.mjs"
)

Write-Host ""
Write-Host "Ready when both windows are open:" -ForegroundColor Green
Write-Host "  1) SSH tunnel  :15722 -> astra.woa.com:80" -ForegroundColor Green
Write-Host "  2) Local proxy  :15723 -> :15722 (sets Host: astra.woa.com)" -ForegroundColor Green
Write-Host "  LLM_BASE_URL=http://127.0.0.1:15723/astra-llm/v1" -ForegroundColor Green
Write-Host ""
Write-Host "Test: .\scripts\astra-tunnel\test-astra.ps1" -ForegroundColor DarkGray
