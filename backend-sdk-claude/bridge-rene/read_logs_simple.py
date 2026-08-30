#!/usr/bin/env python3
import os
import subprocess

log_files = [
    ('/Users/2a/.hermes/logs/audit.log', 'AUDIT.LOG'),
    ('/Users/2a/.hermes/logs/status.log', 'STATUS.LOG'),
    ('/Users/2a/.hermes/logs/group-blocker.log', 'GROUP-BLOCKER.LOG'),
    ('/Users/2a/.hermes/logs/picowatch_stats.json', 'PICOWATCH_STATS.JSON'),
    ('/Users/2a/.hermes/logs/launcher_panic.log', 'LAUNCHER_PANIC.LOG')
]

for log_file, name in log_files:
    print(f'\n=== {name} ===')
    try:
        if os.path.exists(log_file):
            if log_file.endswith('.json') or 'panic' in log_file:
                # Read entire file for JSON and panic logs
                with open(log_file, 'r') as f:
                    content = f.read().strip()
                    if content:
                        print(content)
                    else:
                        print('(arquivo vazio)')
            else:
                # Read last 100 lines for log files
                result = subprocess.run(['tail', '-100', log_file], capture_output=True, text=True)
                if result.returncode == 0:
                    if result.stdout.strip():
                        print(result.stdout)
                    else:
                        print('(arquivo vazio)')
                else:
                    print(f'Erro: {result.stderr}')
        else:
            print('Arquivo não encontrado')
    except Exception as e:
        print(f'Erro: {e}')

print('\n=== FIM DA LEITURA ===')