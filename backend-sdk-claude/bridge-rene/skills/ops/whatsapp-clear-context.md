---
name: whatsapp-clear-context
description: Limpa o histórico/contexto de conversa de um contato do WhatsApp com o agente (produção: hermes-gateway) e avisa que foi limpo. Use quando o usuário pedir para "limpar o contexto", "resetar a conversa/memória" do agente com alguém, geralmente antes de rodar testes.
---

# Limpar contexto do WhatsApp + avisar

Reseta a memória de conversa que o **hermes-gateway** (canal de produção) mantém sobre um
contato, e manda uma mensagem real avisando que foi zerado. Nada disso é reversível
(histórico apagado não volta, mensagem enviada não pode ser "desenviada").

> ⚠️ **Existe um procedimento antigo/legado** (limpar `convHistory` + `sessionContext` do
> backend `hermes-mythos-lucas` via `DELETE /api/whatsapp/context/:jid`) que **não afeta a
> conversa real**, descoberto em 2026-08-12: o endpoint `/v1/chat/completions` que o
> `hermes-gateway` de fato chama (`services/openai-compat.js`) é **stateless**, não usa
> `convHistory` nem `sessionContext`. Quem guarda o histórico é o **cache de sessões do
> próprio hermes-gateway** (SQLite `~/.hermes/state.db`, CLI `hermes sessions`). Rodar o
> procedimento antigo dá `{"success":true}` mas **não limpa nada que importe**. Só use a
> seção "Legado" se o contato estiver passando pelo `whatsappChannel` nativo do backend
> (WhatsApp do próprio `hermes-mythos-lucas` conectado, o que hoje **não** é o caso:
> `WHATSAPP_ENABLED=false` no `.env` dele).

## Caminho preferido: MCP `wa-allowlist` (quando estiver na conversa como agente)

Se você é o agente `rene-dm` respondendo no WhatsApp, use as ferramentas
`mcp__wa-allowlist__*` em vez dos comandos de terminal abaixo:

1. `whatsapp_sessoes_listar` (opcional `numero`) mostra telefone, nº de mensagens, última
   atividade, `id` e título de cada sessão. Confirme o telefone certo.
2. Confirme com o dono, em uma pergunta só: telefone exato + texto do aviso (ou sem aviso).
3. `whatsapp_limpar_contexto` com `numero` e `aviso` (ou `sem_aviso: true`); não há PIN. A
   ferramenta apaga todas as sessões daquele telefone e envia o aviso pela ponte do gateway.
4. `whatsapp_sessoes_listar` com o mesmo `numero` deve voltar vazio.

O restante deste documento é o procedimento manual, para operador no terminal.

## 1. Achar a sessão certa

```bash
export PATH="$HOME/.local/bin:$PATH"
hermes sessions list --source whatsapp --limit 30
```

A lista mostra título/prévia/última atividade, mas não telefone. Para confirmar qual `id` é
do contato, consulte a chave da sessão no banco (somente leitura) ou exporte e confira:

```bash
# direto no banco: telefone é o 5º campo de session_key (agent:main:whatsapp:dm:<TELEFONE>)
python3 -c "
import sqlite3;c=sqlite3.connect('file:$HOME/.hermes/state.db?mode=ro',uri=True)
for r in c.execute(\"select id,session_key,chat_id,message_count,last_activity_at from sessions where source='whatsapp' order by last_activity_at desc\"): print(r)"

# ou exportando a candidata
hermes sessions export - --session-id <ID> --format jsonl | head -c 400
```

Procure `session_key: agent:main:whatsapp:dm:<TELEFONE>` e `chat_id: <LID>@lid` batendo com
o contato. Não há filtro `--phone`/`--chat-id` confiável em `hermes sessions list/export`.

## 2. Confirmar com o usuário antes de disparar

Apagar sessão e mandar mensagem são ações reais e irreversíveis. **Sempre confirme o
contato-alvo e o texto exato do aviso antes de rodar os comandos abaixo.** Não assuma a
partir de instrução ambígua.

## 3. Limpar

```bash
hermes sessions delete <ID> --yes
```

Remove a sessão do SQLite. A próxima mensagem do contato começa do zero (cria sessão nova).
Se o mesmo telefone tiver mais de uma sessão, apague todas.

## 4. Avisar que o contexto foi limpo

Duas opções, ambas pelo canal de produção (gateway do Hermes), nunca pelo
`/api/whatsapp/say` do backend legado:

```bash
# (a) pela ponte Baileys do gateway (campos chatId e message)
curl -s -X POST http://127.0.0.1:3000/send -H 'Content-Type: application/json' \
  -d '{"chatId":"<TELEFONE>@s.whatsapp.net","message":"Contexto limpo, pode mandar de novo."}'

# (b) pelo CLI do Hermes, pelo nome como listado em `hermes send --list whatsapp`
hermes send --to "whatsapp:<Nome do contato>" "Contexto limpo, pode mandar de novo." --quiet
```

Texto sugerido, ajustar com o usuário: curto, sem jargão técnico se o contato não for técnico.

## Diagnóstico rápido

| Sintoma | Causa provável |
| --- | --- |
| Limpei mas o bot ainda "lembra" do assunto | sessão errada (nomes parecidos) ou segunda sessão do mesmo telefone; reconfira `session_key`/`chat_id` |
| `hermes sessions delete` diz sessão não encontrada | ID errado ou já apagada; liste de novo, os IDs mudam a cada sessão nova |
| Aviso não chega no WhatsApp | ponte fora: `curl 127.0.0.1:3000/health` deve dar `connected`; senão `pm2 restart hermes-gateway --update-env` |
| Bot repete resposta velha mesmo com contexto limpo | conferir se o gateway está no modelo esperado (`~/.hermes/config.yaml`, `model.default`) |

## Legado: backend `hermes-mythos-lucas` (só se o WhatsApp nativo dele estiver conectado)

```bash
source /home/box/.hermes/agente-rene/backend-sdk-claude/.env
JID="<telefone-sem-+>@s.whatsapp.net"

curl -s -X DELETE "http://localhost:${PORT}/api/whatsapp/context/${JID}" \
  -H "Authorization: Bearer ${API_BEARER_SECRET}"
curl -s -X POST "http://localhost:${PORT}/api/whatsapp/say" \
  -H "Authorization: Bearer ${API_BEARER_SECRET}" -H "Content-Type: application/json" \
  -d '{"jid":"'"${JID}"'","text":"TEXTO_CONFIRMADO_COM_O_USUARIO"}'
```

Implementação: `routes/whatsapp.js`, rota `DELETE /api/whatsapp/context/:jid`
(`convHistory.clearSession` + `sessionContextManager.clearContext`) e `POST /api/whatsapp/say`
(`whatsappChannel.sendText`). `API_BEARER_SECRET` e `PORT` vêm do `.env`; nunca hardcode.

## Referências

- `hermes sessions` (list/export/delete): CLI do SQLite session store
- Endpoint real da conversa: `services/openai-compat.js` (`/v1/chat/completions`, stateless)
- Ponte do gateway: `127.0.0.1:3000` (`/health`, `/send`)
- MCP: `mcp-servers/wa-allowlist-mcp.mjs`, registrado em `claude-mcp-servers-dm.json`
- Legado: `routes/whatsapp.js` (`/api/whatsapp/say`, `/api/whatsapp/context/:jid`)
