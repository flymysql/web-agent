# Stop Astra SSH tunnel (:15722) and local proxy (:15723) on this PC.
$ErrorActionPreference = 'SilentlyContinue'

function Get-ListenPids($port) {
  $pids = @()
  netstat -ano | ForEach-Object {
    if ($_ -match "^\s*TCP\s+127\.0\.0\.1:$port\s+.*LISTENING\s+(\d+)\s*$") {
      $pids += [int]$Matches[1]
    }
    if ($_ -match "^\s*TCP\s+\[::1\]:$port\s+.*LISTENING\s+(\d+)\s*$") {
      $pids += [int]$Matches[1]
    }
  }
  return $pids | Sort-Object -Unique
}

function Stop-PortListeners($port) {
  foreach ($pid in (Get-ListenPids $port)) {
    if ($pid -le 0) { continue }
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    Write-Host "Stopping PID $pid ($($proc.ProcessName)) on port $port" -ForegroundColor Yellow
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
  }
}

Stop-PortListeners 15723
Stop-PortListeners 15722

Write-Host "Done. Ports 15722/15723 should be free." -ForegroundColor Green
