---
name: liberar-dm
description: Libera uma pessoa nova pra conversar por DM com o René no WhatsApp — allowlist + registro de identidade (contacts.json), pros dois serem reconhecidos juntos. Use quando alguém novo precisa falar com o agente e a mensagem dele está sendo bloqueada (log "número não autorizado") ou tratado como "Desconhecido".
---

# Liberar DM (allowlist + identidade)

Neste projeto (`backend-sdk-claude`, porta 8080) liberar alguém pra falar com o
René por DM precisa de **dois passos**, não só um — só fazer o `dm-allow` não
é suficiente:

1. **Allowlist** (`whatsapp-channel.js` / `_isAllowed`) — decide se a
   mensagem passa ou é descartada no gate. Runtime, sem restart.
2. **Identidade** (`data/contacts.json` / `identity-store.js`) — decide se o
   agente reconhece quem é a pessoa e carrega as instruções dela em
   `data/memory/peers/<person_id>.md`. Só é lido no boot — **precisa de
   restart** se for editado.

Pular o passo 2 faz a pessoa ser tratada como "Desconhecido" mesmo autorizada
— foi exatamente o bug que aconteceu com o Lucas (2026-08-06).

## Passos

Defina as variáveis primeiro:
```bash
cd /home/hermes/agente-rene/backend-sdk-claude
set -a; source .env; set +a
PHONE="5516981591482"      # só dígitos, com DDI+DDD
PERSON_ID="lucas"          # slug estável — vira o nome do arquivo peers/<id>.md
PERSON_NAME="Lucas"        # nome de exibição
```

### 1. Resolver o telefone → JID + LID

```bash
curl -s -H "Authorization: Bearer $API_BEARER_SECRET" \
  http://127.0.0.1:8080/api/whatsapp/resolve/$PHONE
```
Confirma `exists:true` e devolve `jid` (`<phone>@s.whatsapp.net`) e `lid`
(`<numero>@lid`). Guarde só os dígitos do LID — vai precisar nos próximos
passos. Se `exists:false`, o número não tem WhatsApp — pare aqui.

### 2. Allowlist — liberar telefone E lid

O WhatsApp às vezes entrega mensagens identificadas pelo LID em vez do
telefone — sem os dois, uma mesma pessoa pode ser bloqueada por uma
identidade e liberada pela outra. Libere ambos:

```bash
LID="109693481525364"   # só os dígitos, sem "@lid"

curl -s -X POST http://127.0.0.1:8080/api/whatsapp/dm-allow \
  -H "Authorization: Bearer $API_BEARER_SECRET" -H "Content-Type: application/json" \
  -d "{\"number\": \"$PHONE\"}"

curl -s -X POST http://127.0.0.1:8080/api/whatsapp/dm-allow \
  -H "Authorization: Bearer $API_BEARER_SECRET" -H "Content-Type: application/json" \
  -d "{\"number\": \"$LID\"}"
```
Sem restart — já vale na próxima mensagem.

### 3. Identidade — registrar em data/contacts.json

Leia o arquivo, e adicione (sem apagar entradas existentes):
```json
{
  "persons": {
    "<PERSON_ID>": {
      "name": "<PERSON_NAME>",
      "name_source": "manual",
      "discovered_at": "<ISO timestamp atual>"
    }
  },
  "numbers": {
    "<PHONE>": {
      "person_id": "<PERSON_ID>",
      "phone_source": "manual",
      "lids": ["<LID>"]
    }
  }
}
```
`name_source: "manual"` é importante — o código nunca sobrescreve entradas
manuais automaticamente (só `push_name` pode ser trocado sozinho).

### 4. (Opcional, mas recomendado) Criar o arquivo de peer

Se a pessoa precisa de instruções permanentes específicas (o agente injeta
isso em toda conversa com ela):
```bash
touch data/memory/peers/$PERSON_ID.md
```

### 5. Restart — só agora, pra carregar o contacts.json novo

```bash
pm2 restart hermes-mythos-lucas
sleep 6
pm2 logs hermes-mythos-lucas --lines 20 --nostream | grep -iE "identity store|whatsapp conectado"
```
Sessão do WhatsApp já está salva — reconecta sozinho, sem QR novo. Confirme
que "Identity store: N pessoas" subiu.

## Verificação final

```bash
curl -s -H "Authorization: Bearer $API_BEARER_SECRET" \
  http://127.0.0.1:8080/api/whatsapp/dm-allowlist
```
`effective` deve conter `$PHONE` e `$LID`. Depois que a pessoa mandar a
próxima mensagem, confira em `data/whatsapp-conversas.log` se ela aparece com
o nome certo (não "Desconhecido") e se o René respondeu.
