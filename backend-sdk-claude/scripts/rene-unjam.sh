#!/usr/bin/env bash
# lucas-unjam.sh — Diagnostica e (com --fix) destrava o backend hermes-mythos-lucas
# quando as tasks ficam presas em 0 steps (jam de fila / tasks zumbis que
# ressuscitam a cada restart) — o problema visto em 2026-06-20.
#
# Uso:
#   bash scripts/lucas-unjam.sh          # só diagnóstico
#   bash scripts/lucas-unjam.sh --fix    # diagnóstico + resolução se houver jam
#
# Resolução: para o René → backup do tasks.json → cancela queued/running
# (evita zumbis ressuscitando) → sobe limpo → verifica.

APP=hermes-mythos-lucas
DIR="$HOME/hermes-mythos-lucas/backend-sdk-claude"
LOG="$DIR/logs/pm2-out.log"
TASKS="$DIR/data/tasks.json"
PORT=3457
cd "$DIR" || { echo "❌ dir não encontrado: $DIR"; exit 1; }
SECRET=$(grep -E '^API_BEARER_SECRET=' .env 2>/dev/null | cut -d= -f2-)

echo "════════ DIAGNÓSTICO RENÉ ════════"

# 1. Status das tasks
python3 - <<'PY'
import json, collections
try:
    t = json.load(open('data/tasks.json'))
    print('tasks:', dict(collections.Counter(x.get('status') for x in t)))
except Exception as e:
    print('tasks.json erro:', e)
PY

# 2. Fila AO VIVO (tasks.json) — é o sinal confiável; o log tem heartbeats
#    históricos que enganam (linhas antigas de antes do último boot).
QN=$(python3 -c "import json;print(sum(1 for x in json.load(open('data/tasks.json')) if x.get('status') in ('queued','running')))" 2>/dev/null || echo 0)

# 3. ÚLTIMO heartbeat (não o histórico) — só vale se houver task viva (QN>=1),
#    senão é linha velha de log (René idle não emite heartbeat novo).
LASTHB=$(grep -E "hb\] task=" "$LOG" 2>/dev/null | tail -1)
LAST_EL=$(echo "$LASTHB" | grep -oE "elapsed=[0-9]+" | grep -oE "[0-9]+"); LAST_EL=${LAST_EL:-0}
LAST_STEPS=$(echo "$LASTHB" | grep -oE "allSteps=[0-9]+" | grep -oE "[0-9]+"); LAST_STEPS=${LAST_STEPS:-1}
ERR403=$(tail -160 "$LOG" 2>/dev/null | grep -c "transaction failed")
echo "--- último heartbeat ---"; echo "${LASTHB:-(nenhum)}"
echo "fila AO VIVO (queued/running): $QN | últ. heartbeat: elapsed=${LAST_EL}s steps=${LAST_STEPS} | Baileys decrypt('transaction failed'): $ERR403"

# 4. Processos Claude Code vivos
NCLI=$(ps -eo command 2>/dev/null | grep -c "claude-code/cli.js")
NCLI=$(( NCLI > 0 ? NCLI - 1 : 0 ))
echo "processos Claude Code (cli.js) vivos: $NCLI"

# 5. Backend no ar?
UP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/whatsapp/dm-allowlist" -H "Authorization: Bearer $SECRET" 2>/dev/null)
echo "backend HTTP: $UP"

# Veredito (só estado AO VIVO): fila empilhada (>=3) OU task viva travada
# (>=1 na fila E último heartbeat com elapsed>=180s e 0 steps).
JAM=0
if [ "$QN" -ge 3 ]; then JAM=1; fi
if [ "$QN" -ge 1 ] && [ "$LAST_EL" -ge 180 ] && [ "$LAST_STEPS" -eq 0 ]; then JAM=1; fi
echo "──────────────────────────────────"
echo "VEREDITO: $([ "$JAM" -eq 1 ] && echo '🛑 JAM DETECTADO' || echo '🟢 saudável')"
echo "(obs: 'transaction failed' é ruído do Baileys ao descriptografar grupo — NÃO é o jam)"

if [ "${1:-}" != "--fix" ]; then
  echo; echo "→ Pra resolver: bash scripts/lucas-unjam.sh --fix"
  exit 0
fi
if [ "$JAM" -eq 0 ]; then
  echo; echo "Sem jam — nada a resolver."
  exit 0
fi

echo
echo "════════ RESOLUÇÃO ════════"
npx pm2 stop "$APP" >/dev/null 2>&1 && echo "1. René parado (mata subprocessos travados)"
BK="$TASKS.bak-$(date +%Y%m%d-%H%M%S)"
cp "$TASKS" "$BK" && echo "2. backup: $(basename "$BK")"
python3 - <<'PY'
import json
t = json.load(open('data/tasks.json'))
n = 0
for x in t:
    if x.get('status') in ('queued', 'running'):
        x['status'] = 'cancelled'
        x['error'] = 'purgado por lucas-unjam (jam 0-steps)'
        n += 1
json.dump(t, open('data/tasks.json', 'w'), indent=2, ensure_ascii=False)
print(f"3. {n} tasks travadas/enfileiradas canceladas (não ressuscitam no boot)")
PY
npx pm2 start "$APP" >/dev/null 2>&1 || npx pm2 restart "$APP" >/dev/null 2>&1
echo "4. René subindo…"
for i in $(seq 1 20); do
  curl -s "http://localhost:$PORT/api/whatsapp/dm-allowlist" -H "Authorization: Bearer $SECRET" 2>/dev/null | grep -q effective && { echo "5. backend no ar (após ${i}x)"; break; }
  sleep 2
done
sleep 6
echo "--- verificação pós-fix ---"
tail -20 "$LOG" 2>/dev/null | grep -iE "rehidratar|conectado|Task Runner" | tail -4
QN2=$(python3 -c "import json;print(sum(1 for x in json.load(open('data/tasks.json')) if x.get('status') in ('queued','running')))" 2>/dev/null || echo '?')
echo "fila ao vivo após boot: $QN2 $([ "$QN2" = "0" ] && echo '✅ limpo' || echo '⚠️ ainda há tasks — se voltarem a travar, é jam persistente: investigar CLI travando/morrendo na chamada (capturar stderr/exit do filho)')"
echo "✅ lucas-unjam concluído."
