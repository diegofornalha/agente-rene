#!/usr/bin/env bash
# Roda a suíte Jest com o MESMO Node da produção (CLAUDE_NODE_BIN), evitando
# ERR_DLOPEN_FAILED do better-sqlite3: o binário nativo em node_modules é
# compilado pra ABI do Node de produção, e o node default do shell pode ser
# outra major (hoje: produção v22/ABI 127, shell v24/ABI 137).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_BIN="${CLAUDE_NODE_BIN:-}"
if [ -z "$NODE_BIN" ] && [ -f "$ROOT/.env" ]; then
  NODE_BIN="$(grep -m1 '^CLAUDE_NODE_BIN=' "$ROOT/.env" | cut -d= -f2- || true)"
fi
NODE_BIN="${NODE_BIN:-node}"

cd "$ROOT"
exec "$NODE_BIN" node_modules/.bin/jest "$@"
