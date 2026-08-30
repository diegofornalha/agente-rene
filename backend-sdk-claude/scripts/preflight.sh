#!/usr/bin/env bash
# Boot-time validation for hermes-mythos-lucas backend.
# Exits non-zero (with reason on stderr) if any required dependency is missing,
# so PM2 marks the process as errored instead of looping a broken boot.
set -euo pipefail

fail() { echo "[preflight] FAIL: $*" >&2; exit 1; }
warn() { echo "[preflight] warn: $*" >&2; }
ok()   { echo "[preflight] ok: $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Node binary (honors CLAUDE_NODE_BIN from .env / PM2 env)
NODE_BIN="${CLAUDE_NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || fail "node binary '$NODE_BIN' not in PATH"
ok "node $("$NODE_BIN" --version)"

# 2. Local Claude Code CLI (do NOT rely on a global install)
CLI_PATH="$ROOT/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs"
[ -f "$CLI_PATH" ] || fail "Claude Code CLI not found at $CLI_PATH — run 'npm install' first"
CLAUDE_VERSION_OUT="$("$NODE_BIN" "$CLI_PATH" --version 2>&1)" || fail "CLI --version failed: $CLAUDE_VERSION_OUT"
ok "claude $CLAUDE_VERSION_OUT"

# 3. OAuth credentials. The backend depends on the subscription-auth token under
#    ~/.claude/.credentials.json (NOT ANTHROPIC_API_KEY). We only verify presence
#    and permissions — never read the contents.
CREDS_PATH="${HOME}/.claude/.credentials.json"
[ -f "$CREDS_PATH" ] || fail "OAuth credentials missing at $CREDS_PATH — run 'claude login'"

if stat -f '%Lp' "$CREDS_PATH" >/dev/null 2>&1; then
  PERMS="$(stat -f '%Lp' "$CREDS_PATH")"
else
  PERMS="$(stat -c '%a' "$CREDS_PATH")"
fi
[ "$PERMS" = "600" ] || warn "$CREDS_PATH perms=$PERMS (expected 600). Run: chmod 600 \"$CREDS_PATH\""
ok "credentials present (perms=$PERMS)"

# 4. Required runtime dirs (idempotent)
mkdir -p "$ROOT/logs" "$ROOT/data"

ok "preflight passed"
