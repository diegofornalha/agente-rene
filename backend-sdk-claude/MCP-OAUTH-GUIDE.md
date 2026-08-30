# Guia — Ativar um MCP **com OAuth** no René (WhatsApp)

> Companheiro do `MCP-SETUP-GUIDE.md`. Aquele cobre MCP com **token estático**
> (`Bearer ${VAR}` vindo do `.env`), usando o Twenty como exemplo. Este cobre o
> caso em que o servidor MCP autentica por **OAuth** e não existe API key pra
> colocar no `.env` — escrito em 2026-08-15 depois de ativar o **Read AI**.
>
> Leia o `MCP-SETUP-GUIDE.md` antes: a armadilha dos dois sistemas de MCP
> (`claude-mcp-servers-dm.json` vs `data/mcp-servers.json`) vale igual aqui e
> não é repetida.

---

## TL;DR — por que não funcionou de primeira

Duas coisas, nessa ordem:

**1. Instalar no Claude Code não instala no René.** São duas superfícies
independentes:

| Superfície | Config | Quem usa |
| --- | --- | --- |
| Claude Code (CLI/sessão) | `~/.claude.json` | você, no terminal |
| René (agente do WhatsApp) | `claude-mcp-servers-dm.json` | as respostas do bot |

O `claude mcp add --transport http --scope user readai https://api.read.ai/mcp`
resolve **só a primeira**. O René continuou respondendo, com toda razão, que
não tinha o Read AI — porque não tinha mesmo.

**2. O diagnóstico errado que veio depois.** A conclusão inicial foi *"OAuth
não dá pra usar no René, porque o padrão do JSON é header estático do `.env` e
o backend roda headless sob PM2, sem browser pro fluxo OAuth"*.

Isso está errado, e o erro foi assumir que a única via de autenticação era o
header. Não é. O SDK do Claude Code busca credencial de MCP OAuth em
`~/.claude/.credentials.json`, **do usuário que roda o processo**. E o backend
roda como `hermes`:

```bash
ps -o user,pid -p $(pm2 pid hermes-mythos-lucas)
# USER     PID
# hermes   2153299
```

Ou seja: o token que o `claude mcp add` já tinha gravado em
`/home/hermes/.claude/.credentials.json` estava, o tempo todo, **visível pro
backend**. Só faltava declarar o servidor no JSON do agente.

---

## A diferença em relação ao guia do Twenty

```jsonc
// Token estático (Twenty) — precisa de headers + ${VAR} no .env
"twenty": {
  "type": "http",
  "url": "https://crm.meulucroativo.seg.br/mcp",
  "headers": { "Authorization": "Bearer ${TWENTY_API_KEY_DM}" }
}

// OAuth (Read AI) — SEM headers, SEM variável no .env
"readai": {
  "type": "http",
  "url": "https://api.read.ai/mcp"
}
```

**Não crie variável no `.env` pra um MCP OAuth.** Não existe segredo pra
colocar lá; o token vive no credentials store e é renovado sozinho.

### ⚠️ Nome e URL têm que bater exatamente

A credencial é indexada por uma chave derivada do par nome+URL:

```
~/.claude/.credentials.json
└── mcpOAuth
    └── "readai|9538606746f5059d"     ← "<nome>|<hash da URL>"
```

Se você declarar o servidor como `read-ai` (com hífen) ou usar
`https://api.read.ai/mcp/` (com barra no fim) enquanto o `claude mcp add` usou
`https://api.read.ai/mcp`, a chave não casa, o SDK não acha token, e o servidor
**some silenciosamente** — mesmo modo de falha do `${VAR}` vazio descrito no
outro guia. Copie nome e URL do `~/.claude.json`, não de memória.

---

## Pré-requisito — autenticar uma vez no Claude Code

O fluxo OAuth precisa de browser **uma única vez**, na conta do usuário que
roda o backend (`hermes`):

```bash
claude mcp add --transport http --scope user readai https://api.read.ai/mcp
# depois, dentro do Claude Code:  /mcp  →  readai  →  Authenticate
```

O callback é `http://localhost:<porta>/callback`, então precisa de browser na
mesma máquina (Chrome do VNC) ou de um túnel `ssh -L <porta>:localhost:<porta>`.

Feito isso, o bloco `mcpOAuth` aparece no `.credentials.json` e o backend passa
a enxergá-lo. **Não é preciso repetir o OAuth pro René** — ele reaproveita.

---

## Passo a passo

### 1. Declarar no JSON do agente

```bash
cd /home/hermes/agente-rene/backend-sdk-claude
cp claude-mcp-servers-dm.json claude-mcp-servers-dm.json.bak.$(date +%s)
```

Adicionar a entrada (só `type` + `url`) e validar antes de reiniciar:

```bash
python3 -c "import json; print(list(json.load(open('claude-mcp-servers-dm.json'))['mcpServers']))"
# ['google-workspace', 'twenty', 'readai']
```

### 2. Reiniciar o backend

```bash
pm2 restart hermes-mythos-lucas --update-env
```

### 3. Limpar o contexto da conversa

Obrigatório se o agente já disse "não tenho esse MCP" — ele repete de memória
mesmo já tendo a ferramenta. Procedimento na skill `whatsapp-clear-context`:

```bash
hermes sessions list --source whatsapp --limit 30
hermes sessions export - --session-id <ID> --format jsonl | head -c 500   # confirmar session_key
hermes sessions delete <ID> --yes
```

### 4. Verificar **sem** mandar mensagem no WhatsApp

Este é o jeito limpo de testar: chama o mesmo endpoint que o gateway chama, sem
envolver contato nenhum e sem poluir a conversa real.

```bash
cd /home/hermes/agente-rene/backend-sdk-claude
set -a && source .env && set +a
curl -s -m 180 -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" \
  -H "Authorization: Bearer ${OPENAI_COMPAT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"rene-dm","messages":[{"role":"user","content":"Liste quais servidores MCP voce tem disponiveis agora. Depois use a ferramenta do Read AI para buscar a reuniao mais recente e me diga o titulo exato dela."}]}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['choices'][0]['message']['content'])"
```

> `model: "rene-dm"` é obrigatório — só ele carrega o
> `claude-mcp-servers-dm.json` (`services/openai-compat.js:149`). Testar com
> `rene` não prova nada.

Resposta que fechou o caso em 2026-08-15:

```
1. twenty — CRM da Lucro Ativo
2. readai — Read AI (reuniões, transcrições, relatórios)
3. google-workspace — lucas@lucasjuridico.com

Reunião mais recente: "Lucro Ativo <> Alex (ICMS)" — 14/08/2026, Google Meet
```

**Só considere pronto quando vier dado real** (título de reunião que existe),
nunca quando o bot apenas *disser* que tem a ferramenta.

---

## ⚠️ Rotação de refresh token (Ory)

O `authn.read.ai` roda Ory, que **rotaciona o refresh token a cada renovação** —
o antigo é invalidado na hora. Consequências práticas:

- **Não copie** o bloco `mcpOAuth` pra outra máquina/usuário achando que os dois
  vão funcionar. Quem renovar primeiro derruba o outro, e os dois ficam
  alternando entre `✔ Connected` e `! Needs authentication`. Cada ambiente faz
  seu próprio OAuth.
- Claude Code e René **compartilham o mesmo arquivo** (mesmo usuário `hermes`),
  então normalmente se acertam. Se aparecer `Needs authentication`
  intermitente em um dos dois, suspeite de corrida na renovação antes de
  suspeitar da config.

Verificar se a renovação está viva (o `expiresAt` e o prefixo do refresh token
mudam a cada refresh — sinal de que o OAuth está funcionando de verdade):

```bash
python3 -c "
import json,time
e=json.load(open('/home/hermes/.claude/.credentials.json'))['mcpOAuth']['readai|9538606746f5059d']
print('expira em', (e['expiresAt']-time.time()*1000)/1000, 's')
print('refresh prefixo:', e['refreshToken'][:12])
"
```

O access token dura ~10 minutos; expirado não é problema, o refresh cobre.

---

## Troubleshooting

| Sintoma | Causa provável |
| --- | --- |
| Bot diz que não tem o MCP, mas `claude mcp list` mostra `✔ Connected` | você olhou a superfície errada — `claude mcp list` é o Claude Code, não o René. Confira `claude-mcp-servers-dm.json` |
| Declarei no JSON e reiniciei, e o bot continua dizendo que não tem | contexto velho (passo 3), **ou** nome/URL divergente do `~/.claude.json` (chave `mcpOAuth` não casa) |
| Funciona no `curl` mas não no WhatsApp | contexto velho — o `curl` cria sessão nova, o WhatsApp reusa a antiga |
| `Needs authentication` intermitente | refresh token rotacionado por outro cliente usando a mesma credencial |
| Nenhum erro em lugar nenhum e mesmo assim não aparece | padrão desta falha. MCP que não conecta some calado — confira JSON → chave da credencial → restart, nessa ordem |
| Criei `READAI_API_KEY=` no `.env` e não adiantou | MCP OAuth não usa `.env`. Remova, é ruído |

---

## Referências

- `MCP-SETUP-GUIDE.md` — caso do token estático, os dois sistemas de MCP, `rene-dm`
- `claude-mcp-servers-dm.json` — config MCP do agente
- `~/.claude/.credentials.json` — chave `mcpOAuth["<nome>|<hash>"]` (modo 600)
- `~/.claude.json` — registro do servidor no Claude Code (fonte da verdade de nome+URL)
- `services/openai-compat.js:149` — `rene-dm` → `mcpConfigPath`
- Skills: `whatsapp-clear-context`, `monitor-whatsapp-backend`
- Read AI: [MCP Server](https://support.read.ai/hc/en-us/articles/49381158409491-MCP-Server) · [API Reference](https://support.read.ai/hc/en-us/articles/49381161088659-API-Reference)
