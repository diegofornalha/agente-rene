#!/bin/bash
# Limpeza automática de sessões antigas do Claude Code (rolling window).
# Mantém as $KEEP mais recentes por projeto, arquiva o excedente
# (não deleta — move pra ~/.claude/projects-archive/, reversível).
#
# Roda via launchd a cada 6h (com.hermes.claude-cleanup.plist · StartInterval=21600).
# Pode rodar manual: bash scripts/cleanup-sessions.sh
#
# Override do teto via env: KEEP=300 bash scripts/cleanup-sessions.sh

set -u

KEEP="${KEEP:-200}"
PROJECTS_ROOT="$HOME/.claude/projects"
ARCHIVE_DIR="$HOME/.claude/projects-archive"
LOG="$ARCHIVE_DIR/cleanup.log"

mkdir -p "$ARCHIVE_DIR"

timestamp=$(date +%Y%m%d-%H%M%S)
total_moved=0

# Itera por todos os subdirs de projects/ (cada project tem seu próprio rolling window).
for project_dir in "$PROJECTS_ROOT"/*/; do
    [ -d "$project_dir" ] || continue
    project_name=$(basename "$project_dir")

    # Lista jsonl ordenado por mtime DESC (mais recente primeiro).
    sessions=()
    while IFS= read -r line; do
        sessions+=("$line")
    done < <(ls -t "$project_dir"/*.jsonl 2>/dev/null)

    total=${#sessions[@]}
    if [ "$total" -le "$KEEP" ]; then
        continue
    fi

    # Mais antigas (índices KEEP..end) vão pro archive deste project.
    archive_subdir="$ARCHIVE_DIR/$project_name-$timestamp"
    mkdir -p "$archive_subdir"

    moved=0
    for ((i=KEEP; i<total; i++)); do
        session="${sessions[$i]}"
        uuid=$(basename "$session" .jsonl)
        if mv "$session" "$archive_subdir/" 2>/dev/null; then
            moved=$((moved + 1))
            # Move também o subdir UUID/ (subagents, memory snapshots, etc) se houver.
            if [ -d "$project_dir/$uuid" ]; then
                mv "$project_dir/$uuid" "$archive_subdir/" 2>/dev/null
            fi
        fi
    done

    if [ "$moved" -gt 0 ]; then
        echo "[$timestamp] $project_name: arquivadas $moved sessões (de $total; mantidas $KEEP). → $archive_subdir" >> "$LOG"
        total_moved=$((total_moved + moved))
    fi
done

# Sempre registra um heartbeat (mesmo zero) pra confirmar que o cron rodou.
if [ "$total_moved" -eq 0 ]; then
    echo "[$timestamp] heartbeat — nenhum project excedeu $KEEP sessões." >> "$LOG"
fi

exit 0
