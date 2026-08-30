#!/usr/bin/env python3
import subprocess
import sys
import os

def read_log_file(path, name, tail_lines=100):
    print(f'\n=== {name} ===')
    try:
        if not os.path.exists(path):
            print(f'Arquivo {name} não encontrado em {path}')
            return

        if 'panic' in path or 'stats.json' in path:
            # Para arquivos pequenos, ler tudo
            result = subprocess.run(['cat', path], capture_output=True, text=True)
        else:
            # Para logs grandes, ler apenas as últimas linhas
            result = subprocess.run(['tail', f'-{tail_lines}', path], capture_output=True, text=True)

        if result.returncode == 0:
            if result.stdout.strip():
                print(result.stdout)
            else:
                print(f'Arquivo {name} está vazio')
        else:
            print(f'Erro ao ler {name}: {result.stderr.strip()}')
    except Exception as e:
        print(f'Exceção ao ler {name}: {e}')

if __name__ == "__main__":
    logs = [
        ('/Users/2a/.hermes/logs/audit.log', 'AUDIT.LOG'),
        ('/Users/2a/.hermes/logs/status.log', 'STATUS.LOG'),
        ('/Users/2a/.hermes/logs/group-blocker.log', 'GROUP-BLOCKER.LOG'),
        ('/Users/2a/.hermes/logs/picowatch_stats.json', 'PICOWATCH_STATS.JSON'),
        ('/Users/2a/.hermes/logs/launcher_panic.log', 'LAUNCHER_PANIC.LOG')
    ]

    print("Iniciando leitura dos logs do hermes...")

    for path, name in logs:
        read_log_file(path, name)

    print("\n=== FIM DA LEITURA ===")