#!/bin/bash

echo "=== ANÁLISE DE LOGS DO OPENCLAW ==="
echo "Data/Hora: $(date)"
echo ""

# Verificar se os arquivos de log existem
echo "=== STATUS DOS ARQUIVOS DE LOG ==="
for log in audit.log status.log group-blocker.log picowatch_stats.json launcher_panic.log; do
    if [ -f "/Users/2a/.hermes/logs/$log" ]; then
        size=$(stat -f%z "/Users/2a/.hermes/logs/$log" 2>/dev/null || echo "?")
        echo "✅ $log (${size} bytes)"
    else
        echo "❌ $log (não encontrado)"
    fi
done
echo ""

# Ler logs recentes
echo "=== AUDIT.LOG (últimas 50 linhas) ==="
tail -50 "/Users/2a/.hermes/logs/audit.log" 2>/dev/null || echo "❌ Não foi possível ler audit.log"
echo ""

echo "=== STATUS.LOG (últimas 50 linhas) ==="
tail -50 "/Users/2a/.hermes/logs/status.log" 2>/dev/null || echo "❌ Não foi possível ler status.log"
echo ""

echo "=== GROUP-BLOCKER.LOG (últimas 50 linhas) ==="
tail -50 "/Users/2a/.hermes/logs/group-blocker.log" 2>/dev/null || echo "❌ Não foi possível ler group-blocker.log"
echo ""

echo "=== PICOWATCH_STATS.JSON ==="
cat "/Users/2a/.hermes/logs/picowatch_stats.json" 2>/dev/null || echo "❌ Não foi possível ler picowatch_stats.json"
echo ""

echo "=== LAUNCHER_PANIC.LOG ==="
cat "/Users/2a/.hermes/logs/launcher_panic.log" 2>/dev/null || echo "❌ Não foi possível ler launcher_panic.log"
echo ""

# Análise de erros
echo "=== ANÁLISE DE ERROS (todos os logs) ==="
echo "Procurando por: error, ERROR, panic, PANIC, fatal, FATAL, fail, FAIL, timeout, TIMEOUT, refused, REFUSED, EOF"
echo ""

for log in audit.log status.log group-blocker.log; do
    echo "--- Erros em $log ---"
    grep -i "error\|panic\|fatal\|fail\|timeout\|refused\|EOF" "/Users/2a/.hermes/logs/$log" 2>/dev/null | tail -20 || echo "Nenhum erro encontrado ou arquivo inacessível"
    echo ""
done

echo "=== FIM DA ANÁLISE ==="