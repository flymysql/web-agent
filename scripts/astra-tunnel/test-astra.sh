#!/usr/bin/env bash
# Quick smoke test through the SSH tunnel + proxy (run after start-all.sh).
# Reads LLM_* from server/.env — do not commit real keys.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$ROOT/server/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing server/.env" >&2
  exit 1
fi

# Read a single KEY's value from server/.env (last occurrence wins).
get_env() {
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n1 \
    | sed "s/^[[:space:]]*$1=//" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

BASE="$(get_env LLM_BASE_URL)"
KEY="$(get_env LLM_API_KEY)"
MODEL="$(get_env LLM_MODEL)"
EXTRA="$(get_env LLM_EXTRA_HEADERS)"

if [ -z "$BASE" ] || [ -z "$KEY" ]; then
  echo "Set LLM_BASE_URL and LLM_API_KEY in server/.env" >&2
  exit 1
fi

URL="${BASE%/}/chat/completions"

# Base curl args.
args=(-s -w $'\nHTTP:%{http_code}\n'
  -H "Authorization: Bearer $KEY"
  -H "Content-Type: application/json")

# Turn LLM_EXTRA_HEADERS (JSON object) into extra -H args, skipping Host.
if [ -n "$EXTRA" ]; then
  while IFS= read -r h; do
    [ -n "$h" ] && args+=(-H "$h")
  done < <(node -e '
    try {
      const o = JSON.parse(process.argv[1] || "{}");
      for (const [k, v] of Object.entries(o)) {
        if (k.toLowerCase() !== "host") console.log(`${k}: ${v}`);
      }
    } catch { /* not valid JSON — ignore */ }
  ' "$EXTRA")
fi

BODY="$(node -e '
  process.stdout.write(JSON.stringify({
    model: process.argv[1] || "",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 256,
    temperature: 0.7,
  }));
' "$MODEL")"

echo "POST $URL"
OUT="$(curl "${args[@]}" --data-binary "$BODY" "$URL" 2>&1 || true)"

if printf '%s' "$OUT" | grep -q 'HTTP:200'; then
  echo "OK"
  printf '%s' "$OUT" | sed '/^HTTP:200$/d' | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try { console.log(JSON.parse(s).choices[0].message.content); }
      catch { console.log(s.slice(0, 400)); }
    });
  '
else
  echo "FAILED:" >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi
