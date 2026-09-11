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

# 1. Node binary (honors CLAUDE_NODE_BIN from PM2 env, with .env fallback so a
#    manual `bash scripts/preflight.sh` uses the SAME node as production — the
#    2.5 rebuild below would otherwise rebuild the shared binary for the wrong ABI)
NODE_BIN="${CLAUDE_NODE_BIN:-}"
if [ -z "$NODE_BIN" ] && [ -f "$ROOT/.env" ]; then
  NODE_BIN="$(grep -m1 '^CLAUDE_NODE_BIN=' "$ROOT/.env" | cut -d= -f2- || true)"
fi
NODE_BIN="${NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || fail "node binary '$NODE_BIN' not in PATH"
ok "node $("$NODE_BIN" --version)"

# 2. Local Claude Code CLI (do NOT rely on a global install)
CLI_PATH="$ROOT/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs"
[ -f "$CLI_PATH" ] || fail "Claude Code CLI not found at $CLI_PATH — run 'npm install' first"
CLAUDE_VERSION_OUT="$("$NODE_BIN" "$CLI_PATH" --version 2>&1)" || fail "CLI --version failed: $CLAUDE_VERSION_OUT"
ok "claude $CLAUDE_VERSION_OUT"

# 2.5 Native modules — better-sqlite3 ABI must match the running node.
#     require() alone does NOT dlopen the addon; constructing a Database does,
#     so probe with an in-memory open. On mismatch (e.g. after a node upgrade)
#     rebuild in place — this is the failure seen in pm2-err.log historically.
SQLITE_PROBE='new (require("better-sqlite3"))(":memory:")'
if ! "$NODE_BIN" -e "$SQLITE_PROBE" >/dev/null 2>&1; then
  warn "better-sqlite3 failed to load (ABI mismatch?) — rebuilding"
  # O rebuild TEM que rodar sob $NODE_BIN: `npm` do PATH usaria o node do
  # shell e baixaria o prebuild da ABI errada. prebuild-install direto é o
  # caminho confiável (`npm rebuild` de npms antigos reporta sucesso sem
  # trocar o binário); node-gyp via npm fica de fallback.
  if ! (cd "$ROOT/node_modules/better-sqlite3" && "$NODE_BIN" ../.bin/prebuild-install) >/dev/null 2>&1; then
    NPM_CLI="$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js"
    [ -f "$NPM_CLI" ] || NPM_CLI="$(command -v npm)"
    (cd "$ROOT" && "$NODE_BIN" "$NPM_CLI" rebuild better-sqlite3) \
      || fail "better-sqlite3 rebuild failed (prebuild-install e npm rebuild)"
  fi
  "$NODE_BIN" -e "$SQLITE_PROBE" >/dev/null 2>&1 \
    || fail "better-sqlite3 still fails to load after rebuild"
fi
ok "better-sqlite3 native binding loads"

# 3. OAuth credentials. The backend depends on the subscription-auth token (NOT
#    ANTHROPIC_API_KEY). On Linux it lives at ~/.claude/.credentials.json; on
#    macOS the CLI stores it in the login Keychain instead ("Claude Code-credentials"),
#    so accept either. We only verify presence — never read the contents.
CREDS_PATH="${HOME}/.claude/.credentials.json"
if [ -f "$CREDS_PATH" ]; then
  if stat -f '%Lp' "$CREDS_PATH" >/dev/null 2>&1; then
    PERMS="$(stat -f '%Lp' "$CREDS_PATH")"
  else
    PERMS="$(stat -c '%a' "$CREDS_PATH")"
  fi
  [ "$PERMS" = "600" ] || warn "$CREDS_PATH perms=$PERMS (expected 600). Run: chmod 600 \"$CREDS_PATH\""
  ok "credentials present (perms=$PERMS)"
elif [ "$(uname)" = "Darwin" ] && security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then
  ok "credentials present (macOS Keychain)"
else
  echo "[preflight] WARN: OAuth credentials missing ($CREDS_PATH or macOS Keychain) — run 'claude login' (boot continua; Hermes deve usar fallback xAI)" >&2
fi

# 4. Required runtime dirs (idempotent)
mkdir -p "$ROOT/logs" "$ROOT/data"

ok "preflight passed"
