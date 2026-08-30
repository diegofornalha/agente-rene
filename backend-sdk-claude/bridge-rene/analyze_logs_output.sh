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

# Capturar conteúdo dos logs em um formato estruturado
echo "=== DADOS DOS LOGS ==="

echo "--- AUDIT.LOG (últimas 50 linhas) ---"
if [ -f "/Users/2a/.hermes/logs/audit.log" ]; then
    tail -50 "/Users/2a/.hermes/logs/audit.log" 2>/dev/null || echo "❌ Erro ao ler"
else
    echo "❌ Arquivo não encontrado"
fi
echo ""

echo "--- STATUS.LOG (últimas 50 linhas) ---"
if [ -f "/Users/2a/.hermes/logs/status.log" ]; then
    tail -50 "/Users/2a/.hermes/logs/status.log" 2>/dev/null || echo "❌ Erro ao ler"
else
    echo "❌ Arquivo não encontrado"
fi
echo ""

echo "--- GROUP-BLOCKER.LOG (últimas 50 linhas) ---"
if [ -f "/Users/2a/.hermes/logs/group-blocker.log" ]; then
    tail -50 "/Users/2a/.hermes/logs/group-blocker.log" 2>/dev/null || echo "❌ Erro ao ler"
else
    echo "❌ Arquivo não encontrado"
fi
echo ""

echo "--- PICOWATCH_STATS.JSON ---"
if [ -f "/Users/2a/.hermes/logs/picowatch_stats.json" ]; then
    cat "/Users/2a/.hermes/logs/picowatch_stats.json" 2>/dev/null || echo "❌ Erro ao ler"
else
    echo "❌ Arquivo não encontrado"
fi
echo ""

echo "--- LAUNCHER_PANIC.LOG ---"
if [ -f "/Users/2a/.hermes/logs/launcher_panic.log" ]; then
    cat "/Users/2a/.hermes/logs/launcher_panic.log" 2>/dev/null || echo "❌ Erro ao ler"
else
    echo "❌ Arquivo não encontrado"
fi
echo ""

# Análise básica de padrões
echo "=== ANÁLISE BÁSICA DE PADRÕES ==="

echo "--- Contagem de eventos 'unknown' no audit.log ---"
if [ -f "/Users/2a/.hermes/logs/audit.log" ]; then
    grep -c "event=unknown" "/Users/2a/.hermes/logs/audit.log" 2>/dev/null || echo "0"
else
    echo "❌ Arquivo não encontrado"
fi

echo "--- Erros recentes (últimos 20) ---"
for log in audit.log status.log group-blocker.log; do
    echo "-- $log --"
    if [ -f "/Users/2a/.hermes/logs/$log" ]; then
        grep -i "error\|panic\|fatal\|fail\|timeout\|refused\|EOF" "/Users/2a/.hermes/logs/$log" 2>/dev/null | tail -20 || echo "Nenhum erro encontrado"
    else
        echo "❌ Arquivo não encontrado"
    fi
    echo ""
done

echo "=== FIM DA ANÁLISE ==="