# Quick smoke test through the SSH tunnel (run after start-tunnel.ps1).
# Reads LLM_* from server/.env — do not commit real keys.

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envFile = Join-Path $root 'server\.env'
$here = $PSScriptRoot
$configPath = Join-Path $here 'config.local.env'

if (-not (Test-Path $envFile)) {
  Write-Host "Missing server/.env" -ForegroundColor Red
  exit 1
}

$vars = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
  $kv = $_ -split '=', 2
  if ($kv.Length -eq 2) { $vars[$kv[0].Trim()] = $kv[1].Trim() }
}

$base = $vars['LLM_BASE_URL']
$key = $vars['LLM_API_KEY']
$model = $vars['LLM_MODEL']
$extraHeaders = $vars['LLM_EXTRA_HEADERS']

if (-not $base -or -not $key) {
  Write-Host "Set LLM_BASE_URL and LLM_API_KEY in server/.env" -ForegroundColor Red
  exit 1
}

$url = ($base -replace '/$', '') + '/chat/completions'
$headers = @{
  'Authorization' = "Bearer $key"
  'Content-Type'  = 'application/json'
}
if ($extraHeaders) {
  try {
    $parsed = $extraHeaders | ConvertFrom-Json
    $parsed.PSObject.Properties | ForEach-Object {
      if ($_.Name -ne 'Host') { $headers[$_.Name] = $_.Value }
    }
  } catch {
    Write-Host "LLM_EXTRA_HEADERS is not valid JSON" -ForegroundColor Yellow
  }
}

$body = @{
  model       = $model
  messages    = @(@{ role = 'user'; content = 'hello' })
  max_tokens  = 256
  temperature = 0.7
} | ConvertTo-Json -Depth 5 -Compress

Write-Host "POST $url" -ForegroundColor Cyan
$bodyFile = Join-Path $env:TEMP 'astra-test-body.json'
$body | Set-Content -Path $bodyFile -NoNewline -Encoding utf8

$curlArgs = @(
  '-s', '-w', "`nHTTP:%{http_code}`n",
  '-H', "Authorization: Bearer $key",
  '-H', 'Content-Type: application/json',
  '--data-binary', "@$bodyFile",
  $url
)
if ($extraHeaders) {
  try {
    $parsed = $extraHeaders | ConvertFrom-Json
    $parsed.PSObject.Properties | ForEach-Object {
      if ($_.Name -ne 'Host') { $curlArgs = @('-H', "$($_.Name): $($_.Value)") + $curlArgs }
    }
  } catch { }
}

$out = & curl.exe @curlArgs 2>&1 | Out-String
if ($out -match 'HTTP:200') {
  Write-Host 'OK' -ForegroundColor Green
  $json = ($out -replace '(?s)\nHTTP:200\s*$', '').Trim()
  try {
    $resp = $json | ConvertFrom-Json
    Write-Host $resp.choices[0].message.content
  } catch { Write-Host $json.Substring(0, [Math]::Min(400, $json.Length)) }
} else {
  Write-Host "FAILED:" -ForegroundColor Red
  Write-Host $out
  exit 1
}
