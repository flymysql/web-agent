# SSH local forward: PC localhost -> 9.134.186.191 -> astra.woa.com
# Keep this window open while using Astra from your PC.
#
# Usage:
#   1. copy config.example.env config.local.env  (set ASTRA_SSH_USER)
#   2. .\scripts\astra-tunnel\start-tunnel.ps1
#
# Test (another terminal):
#   curl http://127.0.0.1:15722/astra-llm/v1/chat/completions ...

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $here 'config.local.env'
$examplePath = Join-Path $here 'config.example.env'

if (-not (Test-Path $configPath)) {
  Write-Host "Missing $configPath" -ForegroundColor Red
  Write-Host "Copy config.example.env to config.local.env and set ASTRA_SSH_USER." -ForegroundColor Yellow
  exit 1
}

Get-Content $configPath | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
  $kv = $_ -split '=', 2
  if ($kv.Length -eq 2) {
    Set-Item -Path "env:$($kv[0].Trim())" -Value $kv[1].Trim()
  }
}

$hostAddr = $env:ASTRA_SSH_HOST
$sshUser = $env:ASTRA_SSH_USER
$sshPort = if ($env:ASTRA_SSH_PORT) { $env:ASTRA_SSH_PORT } else { '22' }
$localPort = if ($env:ASTRA_LOCAL_PORT) { $env:ASTRA_LOCAL_PORT } else { '15722' }
$remoteHost = if ($env:ASTRA_REMOTE_HOST) { $env:ASTRA_REMOTE_HOST } else { 'astra.woa.com' }
$remotePort = if ($env:ASTRA_REMOTE_PORT) { $env:ASTRA_REMOTE_PORT } else { '80' }

if (-not $sshUser -or $sshUser -eq 'your_rtx_id') {
  Write-Host "Set ASTRA_SSH_USER in config.local.env (your login on $hostAddr)." -ForegroundColor Red
  exit 1
}

$forward = "${localPort}:${remoteHost}:${remotePort}"
# Use Host alias so OpenSSH reads ~/.ssh/config (Port 36000, IdentityFile, etc.)
$sshTarget = if ($sshUser) { "${sshUser}@${hostAddr}" } else { $hostAddr }

Write-Host "Starting SSH tunnel (leave this window open):" -ForegroundColor Cyan
Write-Host "  Local  http://127.0.0.1:${localPort}/astra-llm/v1  ->  ${remoteHost}:${remotePort} via ${sshTarget}" -ForegroundColor Green
if ($env:ASTRA_SSH_PORT -and $env:ASTRA_SSH_PORT -ne '22') {
  Write-Host "  SSH port ${sshPort} (override; ~/.ssh/config also applies when Host matches)" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray

# -F NUL + explicit -p breaks ~/.ssh/config; prefer config file when Host 9.134.186.191 is defined.
$sshConfig = Join-Path $env:USERPROFILE '.ssh\config'
$useSshConfig = (Test-Path $sshConfig) -and (Select-String -Path $sshConfig -Pattern "Host\s+9\.134\.186\.191" -Quiet)

if ($useSshConfig) {
  ssh -N -L $forward $sshTarget
} else {
  ssh -N -p $sshPort -L $forward $sshTarget
}
