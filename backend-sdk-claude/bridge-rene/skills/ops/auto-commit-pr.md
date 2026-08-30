---
name: auto-commit-pr
description: Detecta mudanças em todos os repos relacionados ao hermes, cria commits e PRs. Sabe diferenciar repos próprios (push direto) de forks/upstream (fork + PR).
---

# Auto Commit & PR — Multi-Repo

Verifica mudanças em todos os repos relacionados e cria commits/PRs conforme o caso.

## Repos monitorados

| Repo | Path | Owner | Estratégia |
|------|------|-------|-----------|
| hermes-mythos | /Users/2a/.claude/batalha/hermes-mythos | diegofornalha | push direto + PR |
| OPENCLAW_docs | /Users/2a/.claude/batalha/OPENCLAW_docs | diegofornalha | push direto + PR |
| hermes | /Users/2a/.claude/batalha/hermes | sipeed (upstream) | fork + PR upstream |
| whatsmeow | /Users/2a/.claude/whatsmeow | tulir (upstream) | somente pull, sem push |

## 1. Verificar mudanças em cada repo

```bash
for repo in /Users/2a/.claude/batalha/hermes-mythos /Users/2a/.claude/batalha/OPENCLAW_docs /Users/2a/.claude/batalha/hermes /Users/2a/.claude/whatsmeow; do
  echo "=== $(basename $repo) ==="
  cd "$repo" && git status --porcelain 2>/dev/null | head -10
  echo ""
done
```

Se nenhum repo tiver mudanças, reportar e parar.

## 2. Para cada repo COM mudanças

### Repos próprios (hermes-mythos, OPENCLAW_docs)

```bash
cd <repo>
git diff --stat
BRANCH="mythos/auto-$(date +%Y%m%d-%H%M)"
git checkout -b "$BRANCH"
git add -A
git commit -m "<mensagem descritiva baseada no diff>

Aplicado pelo ciclo autônomo do hermes-mythos
Co-Authored-By: hermes-mythos <noreply@hermes.io>"
git push -u origin "$BRANCH"
gh pr create --title "<titulo>" --body "## Mudanças
<lista>

Aplicado automaticamente pelo hermes-mythos."
git checkout main
```

### Repo upstream (hermes — sipeed/hermes)

Antes de modificar, verificar se existe fork do usuário:
```bash
gh repo view diegofornalha/hermes 2>/dev/null && echo "fork existe" || echo "precisa forkar"
```

Se não tiver fork: `gh repo fork sipeed/hermes --clone=false`

Criar branch no fork:
```bash
cd /Users/2a/.claude/batalha/hermes
git remote add myfork https://github.com/diegofornalha/hermes.git 2>/dev/null
BRANCH="mythos/auto-$(date +%Y%m%d-%H%M)"
git checkout -b "$BRANCH"
git add -A
git commit -m "<mensagem>"
git push myfork "$BRANCH"
gh pr create --repo sipeed/hermes --head "diegofornalha:$BRANCH" --title "<titulo>" --body "<corpo>"
git checkout main
```

### whatsmeow — SOMENTE LEITURA

NÃO commitar nem criar PR no whatsmeow. Se houver mudanças locais, reportar e sugerir que sejam descartadas ou movidas para o hermes.

## 3. Reportar

Para cada repo processado:
- Branch criada
- URL do PR (se criado)
- Arquivos modificados
- Se whatsmeow tem mudanças locais pendentes
