#!/usr/bin/env bash
# PM2 entrypoint. Runs preflight (fast-fail on missing deps) then execs the server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${CLAUDE_NODE_BIN:-node}"

"$SCRIPT_DIR/preflight.sh"

cd "$ROOT"
exec "$NODE_BIN" server.js
