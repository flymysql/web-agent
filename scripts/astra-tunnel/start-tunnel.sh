#!/usr/bin/env bash
# SSH local forward: your Mac/Linux localhost -> 9.134.186.191 -> astra.woa.com
# Keep this terminal open while using Astra from your machine.
#
# Usage:
#   1. cp config.example.env config.local.env   (set ASTRA_SSH_USER)
#   2. ./scripts/astra-tunnel/start-tunnel.sh
#
# Test (another terminal):
#   curl http://127.0.0.1:15722/astra-llm/v1/chat/completions ...
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$HERE/config.local.env"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Missing $CONFIG_PATH" >&2
  echo "Copy config.example.env to config.local.env and set ASTRA_SSH_USER." >&2
  exit 1
fi

# Load KEY=VALUE lines without executing the file (skip comments / blanks).
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|\#*) continue ;;
  esac
  key="${line%%=*}"
  val="${line#*=}"
  [ "$key" = "$line" ] && continue   # no '=' on this line
  # trim surrounding whitespace
  key="$(printf '%s' "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  export "$key=$val"
done < "$CONFIG_PATH"

HOST_ADDR="${ASTRA_SSH_HOST:-9.134.186.191}"
SSH_USER="${ASTRA_SSH_USER:-}"
SSH_PORT="${ASTRA_SSH_PORT:-22}"
LOCAL_PORT="${ASTRA_LOCAL_PORT:-15722}"
REMOTE_HOST="${ASTRA_REMOTE_HOST:-astra.woa.com}"
REMOTE_PORT="${ASTRA_REMOTE_PORT:-80}"

if [ -z "$SSH_USER" ] || [ "$SSH_USER" = "your_rtx_id" ]; then
  echo "Set ASTRA_SSH_USER in config.local.env (your login on $HOST_ADDR)." >&2
  exit 1
fi

FORWARD="${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}"
SSH_TARGET="${SSH_USER}@${HOST_ADDR}"

echo "Starting SSH tunnel (leave this terminal open):"
echo "  Local  http://127.0.0.1:${LOCAL_PORT}/astra-llm/v1  ->  ${REMOTE_HOST}:${REMOTE_PORT} via ${SSH_TARGET}"
echo "  Press Ctrl+C to stop."

# Prefer ~/.ssh/config when it defines this Host (Port/IdentityFile/etc.);
# otherwise pass the port explicitly.
SSH_CONFIG="$HOME/.ssh/config"
if [ -f "$SSH_CONFIG" ] && grep -Eq "Host[[:space:]]+9\.134\.186\.191" "$SSH_CONFIG"; then
  exec ssh -N -L "$FORWARD" "$SSH_TARGET"
else
  exec ssh -N -p "$SSH_PORT" -L "$FORWARD" "$SSH_TARGET"
fi
