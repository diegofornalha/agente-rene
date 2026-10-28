# Hermes só com Claude (ponte `rene-dm`), sem grok — como foi feito

> Feito em 2026-09-27 ~22:52 nesta box (usuário `box`, host `cursor`). Antes, o Hermes
> (gateway do WhatsApp, `pm2: hermes-gateway`) respondia com **grok-4.6** pelo proxy xAI e só
> caía no Claude (`rene-dm`, backend `hermes-mythos-lucas`) como fallback. Agora o Claude pela
> ponte é o **único** modelo de conversa. Companheiro de `BUFFER-MCP.md`.

---

## O que era / o que ficou

| | Antes | Depois |
| --- | --- | --- |
| `model.default` | `grok-4.6` | `rene-dm` |
| `model.base_url` | `http://127.0.0.1:8646/v1` (xai-strip-proxy → hermes-xai-proxy → x.ai) | `http://127.0.0.1:8080/v1` (backend `hermes-mythos-lucas`, `services/openai-compat.js`) |
| `model.api_key` | chave do proxy xAI | `OPENAI_COMPAT_KEY` do `backend-sdk-claude/.env` |
| `fallback_providers` | 1 entrada: `rene-dm` na porta 8080 | **removido** (sem fallback) |
| `image_gen.provider` / plugin `image_gen/xai` | xai | **mantido** (gera imagem, não é conversa) |
| pm2 `hermes-xai-proxy` (8645) e `xai-strip-proxy` (8646) | online | **mantidos online** só para o image_gen |

Arquivo: `~/.hermes/config.yaml`. Backup automático ao lado: `config.yaml.bak-20260927-2252*`.

## Passo a passo (reproduzível)

```bash
# 1. backup
cp ~/.hermes/config.yaml ~/.hermes/config.yaml.bak-$(date +%Y%m%d-%H%M%S)

# 2. chave da ponte (é a mesma que o Hermes já usava no fallback)
KEY=$(grep '^OPENAI_COMPAT_KEY=' ~/.hermes/agente-rene/backend-sdk-claude/.env | cut -d= -f2-)

# 3. topo do config.yaml passa a ser exatamente isto (e o bloco fallback_providers some):
#   model:
#     default: rene-dm
#     provider: custom
#     api_key: <KEY>
#     base_url: http://127.0.0.1:8080/v1

# 4. aplicar (o gateway só lê o config no boot)
pm2 restart hermes-gateway --update-env

# 5. validar sem passar pelo WhatsApp
hermes chat --oneshot -q "Responda em uma linha: qual modelo/backend está respondendo agora?"
#   esperado: "Claude … via ponte OpenAI-compatível do backend-sdk-claude (modelo rene-dm, provider custom)"

# 6. conferir que o WhatsApp continuou conectado depois do restart
curl -s http://127.0.0.1:3000/health     # "status":"connected"
```

## O erro que aconteceu na primeira tentativa (e como reconhecer)

Ao trocar `default`/`base_url`, a `api_key` do bloco `model:` **continuou sendo a do grok**. Sintoma
no `hermes chat --oneshot`: `HTTP 401: invalid api key` em 3 s, e nada no log do backend. O
`openai-compat.js` exige `Authorization: Bearer <OPENAI_COMPAT_KEY>` (função `_authOk`). Corrigir a
chave e reiniciar o gateway resolveu. Regra: **ao mudar o provider, mudar os três campos juntos**
(`default`, `base_url`, `api_key`).

## Consequências que valem saber

- **Sem fallback.** Se o backend Claude cair (`pm2 logs hermes-mythos-lucas`), o Hermes fica sem
  modelo e o WhatsApp responde erro. Antes o grok segurava. O watchdog
  (`~/.hermes/scripts/hermes-watchdog.sh`, a cada 2 min) checa a ponte WhatsApp, **não** o backend 8080;
  se quiser cobrir isso, adicionar um `curl 127.0.0.1:8080/api/health` nele.
- **`authDown` do backend.** Quando a assinatura Claude falha, o `openai-compat.js` responde 503
  `claude_auth_down` de propósito para disparar fallback no cliente. Sem fallback configurado, vira
  erro direto ao usuário. Sinal: `[openai-compat] … authDown` no log e `claude login` pendente.
- **Latência.** grok respondia em ~2 s; a ponte spawna o CLI do Claude Code (10 a 30 s em perguntas
  com ferramentas). No WhatsApp o "digitando…" cobre isso.
- **Ferramentas.** Com `rene-dm` o Hermes **ignora** seus próprios toolsets e MCPs do `config.yaml`
  (`mcp_servers:`): quem executa ferramentas é o Claude spawnado, lendo `claude-mcp-servers-dm.json`.
  Ver `hermes-whatsapp-mcp-two-paths` (memória) — agora só o caminho 2 importa.
- **Contexto antigo.** Sessões do WhatsApp abertas antes da troca continuam; o modelo muda na
  próxima mensagem. Se o bot "lembrar" de ser grok, limpar contexto do contato (skill
  `whatsapp-clear-context`), só com o Diego pedindo.

## Como voltar ao grok (rollback)

```bash
cp ~/.hermes/config.yaml.bak-20260927-2252* ~/.hermes/config.yaml   # o backup mais recente antes da troca
pm2 restart hermes-gateway --update-env
```

Os proxies xAI nunca saíram do ar, então o rollback é só a config.

## Onde isso está registrado

- Este arquivo: `~/.hermes/agente-rene/backend-sdk-claude/HERMES-SO-CLAUDE-SEM-GROK.md`
- Comentário no topo do `~/.hermes/config.yaml`
- Memória do Claude Code: `hermes-whatsapp-mcp-two-paths` (atualizar: default agora é `rene-dm`)
