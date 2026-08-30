#!/usr/bin/env python3
"""
Analisador de logs do OPENCLAW
Procura por padrões de erro mais comuns nos arquivos de log
"""

import os
import re
from collections import defaultdict
from datetime import datetime
import json
import sys

LOGS_PATH = '/Users/2a/.hermes/logs'

LOG_FILES = [
    'audit.log',
    'status.log',
    'group-blocker.log',
    'launcher_panic.log'
]

ERROR_PATTERNS = {
    'go_panic': r'panic:.*',
    'go_fatal': r'fatal.*',
    'go_error': r'error(?::\s*|\s+).*',
    'context_canceled': r'context canceled',
    'connection_reset': r'connection reset by peer',
    'timeout': r'timeout.*',
    'nil_pointer': r'nil pointer.*',
    'goroutine_leak': r'goroutine.*leak',
    'eof_error': r'EOF(?:\s|$)',
    'failed_to': r'failed to.*',
    'cannot_connect': r'cannot connect.*',
    'permission_denied': r'permission denied',
    'no_such_file': r'no such file.*',
    'broken_pipe': r'broken pipe',
    'address_in_use': r'address already in use',
}

def read_log_file(filename):
    """Lê um arquivo de log e retorna as linhas"""
    filepath = os.path.join(LOGS_PATH, filename)
    if not os.path.exists(filepath):
        return []

    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
        return lines
    except Exception as e:
        print(f"Erro ao ler {filename}: {e}")
        return []

def analyze_errors(lines, filename):
    """Analisa linhas para encontrar padrões de erro"""
    error_counts = defaultdict(int)
    error_examples = defaultdict(list)

    for i, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue

        # Verificar cada padrão
        for pattern_name, pattern in ERROR_PATTERNS.items():
            if re.search(pattern, line, re.IGNORECASE):
                error_counts[pattern_name] += 1
                if len(error_examples[pattern_name]) < 5:  # Limitar exemplos
                    error_examples[pattern_name].append({
                        'line': line[:200],  # Truncar linhas muito longas
                        'line_number': i + 1,
                        'file': filename
                    })

    return error_counts, error_examples

def extract_timestamps(line):
    """Extrai timestamp da linha se possível"""
    # Padrões comuns de timestamp
    timestamp_patterns = [
        r'(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2})',
        r'(\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2})',
        r'(\d{2}:\d{2}:\d{2})',
    ]

    for pattern in timestamp_patterns:
        match = re.search(pattern, line)
        if match:
            return match.group(1)
    return None

def get_file_stats(filename):
    """Obtém estatísticas básicas do arquivo"""
    filepath = os.path.join(LOGS_PATH, filename)
    if not os.path.exists(filepath):
        return {'exists': False}

    try:
        stat = os.stat(filepath)
        return {
            'exists': True,
            'size': stat.st_size,
            'size_mb': round(stat.st_size / (1024*1024), 2),
            'modified': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S')
        }
    except Exception as e:
        return {'exists': True, 'error': str(e)}

def main():
    print("🔍 Iniciando análise dos logs do OPENCLAW...")
    print(f"📁 Diretório de logs: {LOGS_PATH}")
    print("=" * 60)

    # Verificar acesso ao diretório
    if not os.path.exists(LOGS_PATH):
        print(f"❌ Diretório de logs não encontrado: {LOGS_PATH}")
        return

    all_error_counts = defaultdict(int)
    all_error_examples = defaultdict(list)
    file_analysis = {}

    # Analisar cada arquivo
    for filename in LOG_FILES:
        print(f"\n📄 Analisando {filename}...")

        # Estatísticas do arquivo
        stats = get_file_stats(filename)
        file_analysis[filename] = stats

        if not stats['exists']:
            print(f"   ❌ Arquivo não encontrado")
            continue

        if 'error' in stats:
            print(f"   ❌ Erro ao acessar arquivo: {stats['error']}")
            continue

        print(f"   📊 Tamanho: {stats['size_mb']} MB")
        print(f"   🕐 Modificado: {stats['modified']}")

        # Ler e analisar conteúdo
        lines = read_log_file(filename)
        if not lines:
            print(f"   📭 Arquivo vazio ou ilegível")
            continue

        error_counts, error_examples = analyze_errors(lines, filename)

        # Consolidar contadores globais
        for pattern, count in error_counts.items():
            all_error_counts[pattern] += count

        # Consolidar exemplos
        for pattern, examples in error_examples.items():
            all_error_examples[pattern].extend(examples)

        # Mostrar top 5 erros do arquivo
        if error_counts:
            top_errors = sorted(error_counts.items(), key=lambda x: x[1], reverse=True)[:5]
            print(f"   🚨 Top 5 erros encontrados:")
            for pattern, count in top_errors:
                print(f"      • {pattern}: {count} ocorrências")
        else:
            print(f"   ✅ Nenhum padrão de erro detectado")

    # Relatório consolidado
    print("\n" + "=" * 60)
    print("📊 RELATÓRIO CONSOLIDADO DE ERROS")
    print("=" * 60)

    if not all_error_counts:
        print("✅ Nenhum padrão de erro detectado em nenhum arquivo!")
        return

    # Top 10 erros globais
    top_global_errors = sorted(all_error_counts.items(), key=lambda x: x[1], reverse=True)[:10]

    print(f"\n🏆 TOP 10 PADRÕES DE ERRO MAIS FREQUENTES:")
    print("-" * 50)
    for i, (pattern, count) in enumerate(top_global_errors, 1):
        print(f"{i:2d}. {pattern}: {count} ocorrências")

    # Exemplos detalhados dos top 5 erros
    print(f"\n🔍 EXEMPLOS DETALHADOS (Top 5):")
    print("-" * 50)

    for pattern, count in top_global_errors[:5]:
        examples = all_error_examples[pattern][:3]  # Top 3 exemplos
        print(f"\n📌 {pattern.upper()} ({count} total):")
        for ex in examples:
            print(f"   📄 {ex['file']}:{ex['line_number']}")
            print(f"   💬 {ex['line']}")
        if len(all_error_examples[pattern]) > 3:
            print(f"   ... e mais {len(all_error_examples[pattern]) - 3} exemplos")

    # Recomendações
    print(f"\n💡 RECOMENDAÇÕES:")
    print("-" * 50)

    recommendations = []

    if all_error_counts.get('context_canceled', 0) > 10:
        recommendations.append("• Alto número de 'context canceled' - verificar timeouts e cancelamentos de contexto")

    if all_error_counts.get('connection_reset', 0) > 5:
        recommendations.append("• Conexões sendo resetadas - verificar estabilidade de rede/conexões")

    if all_error_counts.get('nil_pointer', 0) > 0:
        recommendations.append("• Nil pointer errors detectados - revisar validação de ponteiros no código Go")

    if all_error_counts.get('goroutine_leak', 0) > 0:
        recommendations.append("• Possíveis vazamentos de goroutine - revisar gerenciamento de concorrência")

    if all_error_counts.get('go_panic', 0) > 0:
        recommendations.append("• Panics detectados - adicionar recovery e validação de entrada")

    if not recommendations:
        recommendations.append("• Logs parecem relativamente limpos - continue monitorando")

    for rec in recommendations:
        print(rec)

    print(f"\n✅ Análise concluída!")

if __name__ == "__main__":
    main()