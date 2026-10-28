# Buffer — MCP + CLI (René / bots do grokbot / Claude Code)

> Documento específico do **Buffer** (agendamento de posts em redes sociais). Ativado em
> 2026-09-27 nesta box (usuário `box`), em três superfícies: o bot **Buffer** do grokbot
> (backend `hermes-mythos-lucas`, perfil `rene-buffer`), o **Claude Code** desta máquina e o
> **CLI** `buffer`. O procedimento genérico de MCP estava no `MCP-OAUTH-GUIDE.md` (removido do
> repositório; ver o histórico do git) — aqui só o que é particular do Buffer.
> A boa notícia, comparado à ZapSign: **nada está quebrado**. O servidor remoto oficial aceita o
> token da API direto como Bearer, então o agente headless funciona sem OAuth.

---

## Estado atual

| Item | Valor |
| --- | --- |
| Servidor MCP | `https://mcp.buffer.com/mcp` (remoto, oficial, `buffer-mcp-server 1.0.0`) — transporte HTTP streamable |
| Auth | `Authorization: Bearer <token da API>`. OAuth existe, mas é **opcional** (só para clientes sem lugar para chave) |
| Ferramentas | 20 (lista abaixo) |
| CLI | `@bufferapp/cli` 1.2.0, global (`npm i -g`), config em `~/.config/buffer/config.json` (chmod 600) |
| Conta | `<email-da-conta>` · organização "My organization" `<organizationId>` (veja `buffer config get organizationId`) |
| Canais | TikTok `patinete_amarelo` `<channelId>`, Instagram `patinete_amarelo` `<channelId>`, YouTube `Patinete Amarelo` `<channelId>` |
| Configurado em | `claude-mcp-servers-buffer.json` (perfil `rene-buffer` do backend), `~/.claude.json` (Claude Code), `~/.config/buffer/config.json` (CLI) |
| Skill | `~/.claude/skills/buffer/SKILL.md` (instalada por `buffer install claude`; ensina o CLI) |
| Webhook | Buffer **não oferece** webhooks na API pública (2026-09) |
| Validado | 2026-09-27 22:25: camada 3 (backend `rene-buffer` → `list_channels`) devolveu os 3 canais em 13 s |

---

## O token

Origem: **publish.buffer.com → Settings → API** ("Generate API key"). Formato: 43 caracteres
base64url (ex.: `zUkI…1xcq`). Um só token vale para API GraphQL, MCP remoto e CLI.

Validação em uma linha, sem MCP nenhum (a API é GraphQL em `https://api.buffer.com`):

```bash
T=$(grep '^BUFFER_API_KEY=' ~/.hermes/agente-rene/backend-sdk-claude/.env | cut -d= -f2-)
curl -s -m 20 https://api.buffer.com -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"query":"{ account { email organizations { id name } } }"}'
```

`{"data":{"account":…}}` = ok. `401`/`errors` = token inválido ou revogado.

Onde o token vive (três cópias, rotacionar as três):

| Superfície | Arquivo | Forma |
| --- | --- | --- |
| Backend (bots do grokbot / René) | `backend-sdk-claude/.env` | `BUFFER_API_KEY=<token>` |
| Claude Code | `~/.claude.json` | header literal no servidor `buffer` (chmod 600) |
| CLI | `~/.config/buffer/config.json` | `apiKey` |

> O token foi colado num chat em 2026-09-27. Se quiser rotacionar: gerar outro no painel, trocar
> nos três lugares, `pm2 restart hermes-mythos-lucas --update-env`.

Rate limits (do `buffer doctor`): 100 req / 15 min · 250 / dia · 3000 / 30 dias. O MCP e o CLI
consomem a mesma cota. Bot conversando muito com "lista meus posts" queima cota rápido.

---

## Configuração

### No backend — `claude-mcp-servers-buffer.json` (perfil `rene-buffer`)

```json
"buffer": {
  "type": "http",
  "url": "https://mcp.buffer.com/mcp",
  "headers": { "Authorization": "Bearer ${BUFFER_API_KEY}" }
}
```

E no `.env`: `BUFFER_API_KEY=<token>`. O `${VAR}` é expandido pelo Claude Code ao ler o
`--mcp-config`; a var chega pelo ambiente do pm2 (`dotenv` do server), por isso o restart precisa
de `--update-env`.

Como o perfil entra no backend (mudança de 2026-09-27 em `services/openai-compat.js`): qualquer
`model: rene-<perfil>` carrega `claude-mcp-servers-<perfil>.json`. `rene-dm` continua sendo o
perfil do WhatsApp (sem Buffer). O bot Buffer do grokbot usa `"model": "rene-buffer"` na entrada
dele em `~/.hermes/grok-bridge/bots.json`. O perfil tem também `diegofornalha` (Instagram + Notion
via Smithery) e `grok`.

**Para o René do WhatsApp ter Buffer:** copiar a entrada acima para `claude-mcp-servers-dm.json` e
reiniciar. Não foi feito de propósito: publicar post é ação irreversível e o WhatsApp é canal de
outras pessoas.

### No Claude Code — `~/.claude.json`

```bash
claude mcp add --transport http -s user buffer https://mcp.buffer.com/mcp \
  --header "Authorization: Bearer $T"
claude mcp list   # buffer: … ✔ Connected
```

Sem `--header`, o `claude mcp add` do site oficial fica "Needs authentication" e pede `/mcp` +
login no browser (OAuth). Com o header, conecta direto. Vale a partir da sessão seguinte.

### CLI

```bash
npm i -g @bufferapp/cli
buffer config set apiKey "$T"; buffer config set organizationId <organizationId>
buffer config set timezone America/Sao_Paulo; chmod 600 ~/.config/buffer/config.json
buffer doctor --verbose     # 10/10 em 2026-09-27
buffer install claude       # skill em ~/.claude/skills/buffer (deprecado: use `buffer agent install claude`)
```

`buffer init` é interativo (não usar sob pm2 nem em sessão headless). Em CI/container:
`export BUFFER_API_KEY=…` em vez de gravar no disco.

---

## As 20 ferramentas do MCP

**Conta / canais** — `get_account`, `list_channels`, `get_channel`
**Posts** — `list_posts`, `get_post`, `create_post`, `edit_post`, `delete_post`, `get_aggregated_post_metrics`
**Ideias** — `list_idea_groups`, `list_ideas`, `create_idea`
**Modelos de post** — `list_post_templates`, `get_post_template`, `create_post_template`, `update_post_template`, `delete_post_template`
**Escape para o GraphQL** — `execute_query`, `execute_mutation`, `introspect_schema`

Fluxo recomendado pelo próprio servidor: `get_account` → `list_channels` (pegar `channelId`) →
`create_post` com `schedulingType` (`automatic` = próxima vaga da fila) e `mode` (`addToQueue`,
`shareNow`, `shareNext`, `customScheduled`). O CLI tem `--dry-run` em toda mutação; o MCP não.

---

## ⚠️ Risco operacional: é produção

`create_post` com `mode: shareNow` **publica na hora** no Instagram/TikTok/YouTube do Patinete
Amarelo. `delete_post` apaga da fila. Não há sandbox no Buffer. O bot Buffer do grokbot roda com
`bypassPermissions`, então um pedido mal interpretado vira post público.

Mitigação em uso: o prompt de sistema do bot (bots.json) pede confirmação antes de publicar e
proíbe `shareNow` sem o Diego dizer "publica agora". Mitigação possível: perfil só-leitura
(remover `create_post`/`edit_post`/`delete_post` não dá no servidor remoto; teria de ser
via `disallowedTools` no `claude-query.js`, não implementado).

---

## Como testar

**Camada 1 — API aceita o token?** O `curl` da seção do token.

**Camada 2 — o servidor MCP responde com esse token?** (sem OAuth)

```bash
curl -s -m 20 https://mcp.buffer.com/mcp -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

Espera-se `"serverInfo":{"name":"buffer-mcp-server"…}`. Sem header: `401`.

**Camada 3 — o backend enxerga?** Sem passar pelo grokbot:

```bash
KEY=$(grep '^OPENAI_COMPAT_KEY=' .env | cut -d= -f2-)
curl -s -m 300 http://127.0.0.1:8080/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"model":"rene-buffer","messages":[{"role":"user","content":
  "Use a ferramenta list_channels do MCP buffer e liste meus canais (rede e nome). Se não tiver a ferramenta, responda SEM_FERRAMENTA."}]}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['choices'][0]['message']['content'])"
```

**Camada 4 — grokbot.** No grupo "Buffer (Claude)", pedir **dado**: "quais canais tenho no Buffer?".
Perguntar "o MCP está funcionando?" não chama ferramenta — ele responde de memória.

**CLI:** `buffer channels list` · `buffer posts list --channel-id <id>`.

---

## Diagnóstico rápido

| Sintoma | Causa |
| --- | --- |
| `401` no MCP / "invalid api key" | header ausente ou token revogado; `.env` sem `BUFFER_API_KEY` ou faltou `--update-env` |
| Claude Code mostra "Needs authentication" | adicionado sem `--header`; remover e adicionar de novo com o header |
| Backend responde chat puro, sem ferramenta | `model` não é `rene-buffer`, ou o `claude-mcp-servers-buffer.json` não existe (cai em chat) |
| Bot Buffer diz "não tenho ferramenta" | contexto velho no grupo, ou backend não reiniciado após criar o perfil |
| `rate limit` no doctor | cota de 100/15 min compartilhada entre CLI, MCP e bot |
| Post apareceu publicado sem querer | `mode: shareNow`; usar `addToQueue` e revisar em publish.buffer.com |

---

## Referências

- Developers: https://developers.buffer.com/ (Quick Start, API Reference, Explorer, guias Claude/ChatGPT/Cursor)
- Gerar token: https://publish.buffer.com/settings/api
- CLI: `npm i -g @bufferapp/cli` · `buffer context` imprime os skills em markdown
- Nesta box: `claude-mcp-servers-buffer.json`, `services/openai-compat.js` (`_profileMcpConfig`), `~/.hermes/grok-bridge/bots.json`, skill `chat-post-grok`
