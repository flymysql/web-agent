#!/usr/bin/env bash
# Starts the SSH tunnel + local Host-rewrite proxy in the background.
# Usage: ./scripts/astra-tunnel/start-all.sh
#
# Logs:  /tmp/astra-tunnel.log  and  /tmp/astra-proxy.log
# Stop:  ./scripts/astra-tunnel/stop-all.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

port_up() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }

proxy_up=false; tunnel_up=false
port_up 15723 && proxy_up=true
port_up 15722 && tunnel_up=true

if $proxy_up && $tunnel_up; then
  echo "Astra tunnel (:15722) and proxy (:15723) already running — nothing to start."
  echo "LLM_BASE_URL=http://127.0.0.1:15723/astra-llm/v1"
  exit 0
fi

if $proxy_up || $tunnel_up; then
  echo "Partially running (tunnel=$tunnel_up proxy=$proxy_up). Cleaning up first..."
  "$HERE/stop-all.sh"
  sleep 1
fi

echo "Starting Astra SSH tunnel (background, log: /tmp/astra-tunnel.log)..."
nohup bash "$HERE/start-tunnel.sh" >/tmp/astra-tunnel.log 2>&1 &
sleep 2

echo "Starting local proxy (Host rewrite for Node fetch, log: /tmp/astra-proxy.log)..."
nohup node "$ROOT/scripts/astra-tunnel/local-proxy.mjs" >/tmp/astra-proxy.log 2>&1 &
sleep 1

echo ""
echo "Ready:"
echo "  1) SSH tunnel  :15722 -> astra.woa.com:80"
echo "  2) Local proxy  :15723 -> :15722 (sets Host: astra.woa.com)"
echo "  LLM_BASE_URL=http://127.0.0.1:15723/astra-llm/v1"
echo ""
echo "Test: ./scripts/astra-tunnel/test-astra.sh"
echo "Stop: ./scripts/astra-tunnel/stop-all.sh"
