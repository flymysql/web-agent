#!/usr/bin/env bash
# Stop Astra SSH tunnel (:15722) and local proxy (:15723) on this machine.
set -uo pipefail

stop_port() {
  port="$1"
  # lsof lists PIDs listening on the TCP port (loopback included).
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    echo "Nothing listening on :${port}"
    return
  fi
  for pid in $pids; do
    name="$(ps -p "$pid" -o comm= 2>/dev/null || echo '?')"
    echo "Stopping PID $pid ($name) on port ${port}"
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  # Force-kill anything still holding the port.
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
}

stop_port 15723
stop_port 15722

echo "Done. Ports 15722/15723 should be free."
