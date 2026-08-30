'use strict';
// conv-log.js — log append-only de conversas do WhatsApp (formato blueprint).
// Cada linha: "<ISO> [<papel>]: <texto>". Papel = número do remetente pra
// mensagens recebidas, "bot" pra respostas enviadas. Mensagens podem ter \n
// internos — escapamos pra manter 1 mensagem = 1 linha (essencial pra grep).

const path = require('path');
const { createRotator } = require('./log-rotator');

const CONV_LOG_PATH = process.env.WHATSAPP_CONV_LOG
  || path.join(__dirname, '..', '..', 'data', 'whatsapp-conversas.log');

const _convLogRotator = createRotator(CONV_LOG_PATH, {
  onRotate: (ev) => console.log(
    `📒 whatsapp conv log rotated (${ev.reason}): ${path.basename(ev.from)} → ${path.basename(ev.to)} (${ev.size} bytes)`
  ),
});

function _appendConv(role, text) {
  const line = `${new Date().toISOString()} [${role}]: ${String(text).replace(/\n/g, '\\n')}\n`;
  _convLogRotator.write(line);
}

// JID → identificador humano. Ex: "5511999990000@s.whatsapp.net" → "+5511999990000".
// Pra @lid (linked-id privado do multi-device) mantém prefixo.
function _jidToRole(jid) {
  if (!jid) return 'unknown';
  const [num, domain] = jid.split('@');
  if (domain === 's.whatsapp.net') return `+${num}`;
  if (domain === 'lid') return `lid:${num}`;
  return jid;
}

module.exports = { CONV_LOG_PATH, _appendConv, _jidToRole };
