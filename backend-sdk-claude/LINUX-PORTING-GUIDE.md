# Guia — Rodar o backend no Linux (userland, sem sudo) + bug `spawn E2BIG`

> Companheiro do `RUNBOOK.md`. Este arquivo registra **como portamos o
> `backend-sdk-claude` de macOS para Linux** numa máquina **sem `sudo`, sem
> `npm`, sem toolchain de build e sem binários de mídia** — e como diagnosticamos
> e corrigimos o `spawn E2BIG` que impedia o Claude Code de responder.
> Use como checklist numa próxima instalação limpa.

Data da migração de referência: **2026-07-13**. Host: Linux x86_64, usuário `hermes`, `/home/hermes`.

---

## TL;DR (o que resolveu)

1. **Node 22 + npm em userland** (tarball em `~/opt/node`) — sem root.
2. **ffmpeg/ffprobe static** em `~/bin` — sem root.
3. **`npm install` com `PUPPETEER_SKIP_DOWNLOAD=1`** (puppeteer não é usado no código).
4. **De-hardcodar caminhos macOS** (`/opt/homebrew`, `/Users/...`) → env-configuráveis.
5. **Bug crítico:** o prompt ia como **argumento de linha de comando**; no Linux o
   limite por-argumento (`MAX_ARG_STRLEN` = 128KB) estoura → `spawn E2BIG`. **Correção:
   passar o prompt via `stdin`** em `claude-query.js`. No macOS não falhava (limite maior).
6. **Auth do Claude** já vinha ok: `~/.claude/.credentials.json` (modo 600) + CLI. Não é API key.

---

## 0. Sanity check do ambiente (rodar antes de tudo)

```sh
id -un                                   # quem sou
sudo -n true 2>/dev/null && echo "sudo ok" || echo "SEM sudo"
command -v node npm corepack             # node? npm? (npm costuma faltar em Debian)
for b in make g++ cc pkg-config; do command -v $b || echo "$b MISSING"; done
for b in ffmpeg ffprobe whisper-cli weasyprint; do command -v $b || echo "$b MISSING"; done
ls -la ~/.claude/.credentials.json       # auth do Claude presente? (modo 600)
command -v claude                        # CLI do Claude Code (global ou local)
```

Se `sudo` faltar e `npm`/toolchain/mídia estiverem MISSING, siga o caminho **userland** abaixo.

---

## 1. Runtime em userland (sem root)

### Node 22 + npm (via tarball oficial)
> Node 22 é o recomendado (`claude-query.js`: o `cli.js` v1 crasha no Node 25).

```sh
mkdir -p ~/opt ~/bin ~/.whisper-models
cd ~/opt
V=22.20.0
curl -fsSL -o node.tar.xz "https://nodejs.org/dist/v$V/node-v$V-linux-x64.tar.xz"
tar -xf node.tar.xz && rm node.tar.xz
rm -rf ~/opt/node && mv "node-v$V-linux-x64" ~/opt/node
~/opt/node/bin/node -v && ~/opt/node/bin/npm -v      # v22.x / 10.x
```

Deixe no PATH (`~/.bashrc` / `~/.profile`):
```sh
export PATH="$HOME/opt/node/bin:$HOME/bin:$PATH"
```

### ffmpeg / ffprobe (build estático — cobre áudio/vídeo/HeyGen, sem libs de sistema)
```sh
cd ~/opt
curl -fsSL -o ff.tar.xz "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
tar -xf ff.tar.xz && rm ff.tar.xz
D=$(ls -d ffmpeg-*-amd64-static | head -1)
cp "$D/ffmpeg" "$D/ffprobe" ~/bin/ && rm -rf "$D"
~/bin/ffmpeg -version | head -1
```

---

## 2. Instalar dependências

```sh
cd <repo>/backend-sdk-claude
export PATH="$HOME/opt/node/bin:$HOME/bin:$PATH"
export PUPPETEER_SKIP_DOWNLOAD=1     # puppeteer é dep declarada mas NÃO usada no código
npm install --no-audit --no-fund
```

- `PUPPETEER_SKIP_DOWNLOAD=1` evita baixar o Chromium (que ainda precisaria de libs de
  sistema em runtime). Confirme que não é usado: `grep -rn "puppeteer" --include=*.js . | grep -v node_modules`.
- `better-sqlite3` é nativo mas instala via **prebuild** no Node 22 linux-x64 — não precisa de compilador.
  Se cair para compilar (sem `g++`), foi porque a ABI não tinha prebuild → fixe o Node 22.

---

## 3. De-hardcodar caminhos de SO (portabilidade; mantém macOS funcionando)

Padrão: trocar constante fixa por `process.env.X || <default resolvível no PATH>`.
Achar tudo:
```sh
grep -rnE "/opt/homebrew|/Users/" --include=*.js services server.js claude-query.js | grep -v node_modules
```

Arquivos alterados nesta migração:

| Arquivo | Antes | Depois |
|---|---|---|
| `services/whatsapp/whatsapp-channel.js` | `FFMPEG_BIN/WHISPER_BIN` → `/opt/homebrew/...`; `WHISPER_MODEL` → `/Users/...` | `'ffmpeg'` / `'whisper-cli'` (PATH); modelo só via `WHISPER_MODEL` |
| `services/doc-converter.js` | `WEASYPRINT = '/opt/homebrew/bin/weasyprint'` (sem env) | `process.env.WEASYPRINT \|\| 'weasyprint'` |
| `server.js` | `/Users/2a/.hermes/workspace/...` em 3 endpoints (René/Instagram) | `RENE_WS = process.env.RENE_WORKSPACE \|\| ~/.hermes/workspace` |

> **Nota René/Instagram:** de-hardcodar os caminhos **não** faz o endpoint rodar — ele
> depende de scripts Python externos (`instagram/`, `linkedin_poster.py`, `translate-image.py`)
> que **não estão no repo**. Portar o caminho é o que dá; rodar exige trazer esses assets.
>
> **weasyprint (PDF):** precisa de libs de sistema (Pango/cairo) → sem sudo não sobe.
> Mas não está em fluxo vivo (só utilitário manual), então não bloqueia o bot.

---

## 4. Bug crítico: `spawn E2BIG` (o que travava as respostas)

### Sintoma
WhatsApp conecta e recebe a mensagem, mas o bot só devolve a mensagem genérica de erro.
Nos logs:
```
🔁 Task ... retry #3/5 — spawn E2BIG
✅ Task ... error (0.0s)
📤 WhatsApp → ...@lid (error): 🤔 Hmm, deu um problema aqui do meu lado.
```

### Causa raiz
`claude-query.js` spawnava `node cli.js ... -- <prompt>` passando o **prompt inteiro como
argumento**. O `task-runner.js` monta o `fullPrompt` concatenando **contexto de memória
(findings/debts/changelog) + system prompt + contexto de retry** — facilmente > 128KB.

No Linux, o `execve` limita **cada argumento** a `MAX_ARG_STRLEN` = `PAGE_SIZE*32` = **128KB**.
Passou disso → `E2BIG`. No **macOS o limite é maior**, por isso só quebrou no Linux.

> Diagnóstico rápido de que **não** era o environment (o outro suspeito de E2BIG):
> ```sh
> PID=$(pgrep -f "node server.js"); tr '\0' '\n' < /proc/$PID/environ | wc -c   # env minúsculo (~4KB) → não é o env
> ```

### Correção
Passar o prompt via **stdin** (o CLI lê stdin em `--print`, `--input-format text` é default).
Em `claude-query.js`:

- Remover `args.push('--', prompt)`.
- `stdio: ['ignore','pipe','pipe']` → `stdio: ['pipe','pipe','pipe']`.
- Após o spawn:
  ```js
  if (child.stdin) {
    child.stdin.on('error', () => {});        // evita crash por EPIPE se o filho morrer antes
    child.stdin.write(String(prompt ?? ''));
    child.stdin.end();
  }
  ```

### Teste isolado da correção (sem WhatsApp)
Prompt de 200KB (acima do limite) tem que voltar sucesso:
```sh
export PATH="$HOME/opt/node/bin:$PATH"
node -e '
const { query } = require("./claude-query");
(async () => {
  const big = "Responda apenas: OK. " + "x".repeat(200000);
  for await (const m of query({ prompt: big, options: { maxTurns: 1, permissionMode: "bypassPermissions" } }))
    if (m.type === "result") console.log("subtype=", m.subtype, "is_error=", m.is_error, "->", String(m.result).slice(0,80));
  process.exit(0);
})();'
# Esperado:  subtype= success is_error= false -> OK.
```

---

## 5. `.env` (Linux)

Não há `.env.example` preenchido. Mínimo para subir + escopo completo:
```
PORT=8080
CLAUDE_NODE_BIN=/home/hermes/opt/node/bin/node
WHATSAPP_ENABLED=true
WHATSAPP_ALLOWED_NUMBERS=          # vazio = libera todos; trave em números conhecidos no começo
WHATSAPP_AUTH_DIR=./data/whatsapp-auth
WHATSAPP_QR_PNG=/tmp/whatsapp-qr.png
FFMPEG_BIN=/home/hermes/bin/ffmpeg
WHISPER_BIN=/home/hermes/bin/whisper-cli     # ver nota whisper
WHISPER_MODEL=/home/hermes/.whisper-models/ggml-small.bin
WHISPER_LANG=pt
WEASYPRINT=weasyprint
RENE_WORKSPACE=/home/hermes/.hermes/workspace
# opcionais: ELEVENLABS_API_KEY, HEYGEN_API_KEY, TELEGRAM_ENABLED, API_BEARER_SECRET, SOCKET_IO_CORS_ORIGIN
```

> **whisper (voz):** sem compilador não dá pra buildar o whisper.cpp. Opções: (A) baixar
> binário prebuilt + modelo `ggml-small.bin`; (B) adaptar `_transcribe` para uma API de nuvem
> (Groq/OpenAI Whisper) atrás da mesma função; (C) aceitar áudio sem transcrição. ffmpeg (static)
> já cobre toda a conversão de áudio/vídeo.

---

## 6. Subir e verificar (end-to-end)

```sh
cd <repo>/backend-sdk-claude
export PATH="$HOME/opt/node/bin:$HOME/bin:$PATH"

bash scripts/preflight.sh          # deve sair 0 (acha cli.js local, node, creds 600)
bash scripts/start.sh              # OU via PM2 (abaixo)
```

PM2 (opcional; `pm2 startup` precisa de root → pular, usar boot manual/cron):
```sh
npm config set prefix ~/.local && npm i -g pm2
~/.local/bin/pm2 start ecosystem.config.js
~/.local/bin/pm2 reload hermes-mythos-lucas --update-env   # após mudar código/.env
~/.local/bin/pm2 save
```

### Checklist de verificação
1. **Conectou?** nos logs: `✅ WhatsApp conectado como +55...` e `👁️ Grupos observados: ...`.
2. **QR:** se aparecer QR em `/tmp/whatsapp-qr.png` e ficar parado → ainda não pareou (escanear em
   WhatsApp → Aparelhos conectados). Se as mensagens fluem, o QR é só arquivo residual.
3. **E2BIG sumiu?**
   ```sh
   grep -c E2BIG logs/pm2-out.log        # deve parar de crescer após o reload da correção
   ```
4. **Agente responde de verdade?** Mandar DM e acompanhar o ciclo nos logs — tem que ir de
   `▶️ Task ... started` a `✅ Task ... success` (NÃO `error (0.0s)`), seguido de `📤 WhatsApp → ...`.

### Monitorar uma conversa específica ao vivo
Resolver o LID de um número (JIDs nos logs aparecem como `<lid>@lid`):
```sh
cat data/whatsapp-auth/lid-mapping-<NUMERO>.json     # ex.: 5511999990000 → "176437373976751"
```
Tail filtrado (não use `pkill` no padrão do próprio tail — ele se mata):
```sh
stdbuf -oL tail -n 0 -F logs/pm2-out.log | stdbuf -oL grep --line-buffered -iE \
  "<LID>|<NUMERO>|Mensagem atual|▶️|✅ Task|❌|📤 WhatsApp →|E2BIG"
```

### Grupos
O bot só responde em grupo se: o JID estiver em `WHATSAPP_OPEN_GROUPS`, ou o grupo tiver
`{ "open": true }` em `data/whatsapp-groups.json`, ou **o bot for @mencionado**. Grupo novo só
revela o JID (`120363...@g.us`) quando chega a primeira mensagem dele nos logs.

---

## Referência rápida de troubleshooting

| Sintoma | Causa provável | Ação |
|---|---|---|
| `spawn E2BIG` | prompt como argv > 128KB no Linux | prompt via stdin (Seção 4) |
| `spawn ENOENT` | `CLAUDE_NODE_BIN`/`cli.js` fora do PATH/lugar | conferir `node_modules/@anthropic-ai/claude-code/cli.js` e `CLAUDE_NODE_BIN` |
| bot responde só "🤔 Hmm, deu um problema" | turno do Claude falhou (E2BIG, auth, exit≠0) | ver `error:`/`stderr:` no log do close |
| `failed to find key ... to decode mutation` | app-state sync do Baileys (warn, não-fatal) | ignorar; some após o sync |
| ffmpeg/whisper "não encontrado" | binário fora do PATH | setar `FFMPEG_BIN`/`WHISPER_BIN` absolutos no `.env` |
| `better-sqlite3` tenta compilar e falha | sem prebuild p/ a ABI / sem g++ | usar Node 22 (tem prebuild) |
| preflight falha em credenciais | `~/.claude/.credentials.json` ausente/perm | `claude login`; `chmod 600` |
