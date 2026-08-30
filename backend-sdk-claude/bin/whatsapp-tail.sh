#!/usr/bin/env bash
# Catch-up das últimas N mensagens do canal WhatsApp (sem armar Monitor).
# Uso: ./bin/whatsapp-tail.sh [N]   (default N=30)

set -euo pipefail

LOG="${WHATSAPP_CONV_LOG:-/Users/hermes/hermes-mythos-lucas/backend-sdk-claude/data/whatsapp-conversas.log}"
N="${1:-30}"

if [ ! -f "$LOG" ]; then
  echo "log de conversas não existe ainda: $LOG" >&2
  exit 1
fi

tail -n "$N" "$LOG"
