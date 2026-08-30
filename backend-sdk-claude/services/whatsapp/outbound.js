'use strict';
// outbound.js — API externa do canal WhatsApp: envio direto (texto, voz,
// vídeo, documento), perfil do bot e operações de grupo. Usado pelas rotas
// /api/whatsapp/* do server.js. Socket via sock-ref (core é quem conecta).

const fs = require('fs-extra');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const sockRef = require('./sock-ref');
const { _appendConv, _jidToRole } = require('./conv-log');
const { _stripLinkFormatting } = require('./message-extract');
const { TTS_ENABLED, _synthesizeTTS, _mp3ToOggOpus } = require('./tts');
const { addObservedGroup } = require('./group-registry');

// ── API externa: enviar mensagens diretas (pra rota POST /api/whatsapp/say) ──
async function sendText(jid, text) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  text = _stripLinkFormatting(text);
  await sock.sendMessage(jid, { text });
  _appendConv(`bot→${_jidToRole(jid)}`, text);
}

async function sendVoice(jid, text) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  if (!TTS_ENABLED) throw new Error('TTS não habilitado (ELEVENLABS_API_KEY ausente)');
  const mp3 = await _synthesizeTTS(text);
  const ogg = await _mp3ToOggOpus(mp3);
  await sock.sendMessage(jid, {
    audio: ogg,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  });
  _appendConv(`bot→${_jidToRole(jid)}`, `[áudio TTS direto] ${text.slice(0, 120)}`);
}

// Envia um vídeo (Buffer MP4) como mídia no WhatsApp, com legenda opcional.
async function sendVideo(jid, videoBuffer, caption) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  if (!Buffer.isBuffer(videoBuffer)) throw new Error('sendVideo exige um Buffer de vídeo');
  await sock.sendMessage(jid, {
    video: videoBuffer,
    mimetype: 'video/mp4',
    caption: caption || undefined,
  });
  _appendConv(`bot→${_jidToRole(jid)}`, `[vídeo]${caption ? ' ' + caption.slice(0, 80) : ''}`);
}

async function sendDocument(jid, docBuffer, filename, mimetype, caption) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  if (!Buffer.isBuffer(docBuffer)) throw new Error('sendDocument exige um Buffer');
  await sock.sendMessage(jid, {
    document: docBuffer,
    mimetype: mimetype || 'application/octet-stream',
    fileName: filename || 'document',
    caption: caption || undefined,
  });
  _appendConv(`bot→${_jidToRole(jid)}`, `[documento] ${filename || 'doc'}${caption ? ' — ' + caption.slice(0, 60) : ''}`);
}


// Atualiza a foto de perfil DO PRÓPRIO bot no WhatsApp.
// Baileys (sharp) recorta/redimensiona a imagem internamente.
async function setProfilePhoto(imagePathOrBuffer) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  const selfJid = sock.user?.id;
  if (!selfJid) throw new Error('JID do próprio bot indisponível');
  const buffer = Buffer.isBuffer(imagePathOrBuffer)
    ? imagePathOrBuffer
    : await fs.readFile(imagePathOrBuffer);
  await sock.updateProfilePicture(jidNormalizedUser(selfJid), buffer);
  _appendConv('config', `[foto de perfil do bot atualizada — ${buffer.length} bytes]`);
  return { ok: true, jid: jidNormalizedUser(selfJid), bytes: buffer.length };
}

// Cria um grupo WhatsApp e retorna metadata (id, subject, participants).
async function createGroup(subject, participantJids = [], { open = true } = {}) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  const meta = await sock.groupCreate(subject, participantJids);
  _appendConv('config', `[grupo criado: "${subject}" — ${meta.id}]`);
  // Já registra como observado + aberto em runtime, pra responder a todos os
  // membros de primeira — sem editar código nem reiniciar.
  if (meta?.id) addObservedGroup(meta.id, subject, { open });
  return meta;
}

// Retorna metadata do grupo + tenta resolver cada participante `@lid` em telefone
// via `signalRepository.lidMapping.getPNForLID` (USync no servidor do WhatsApp).
async function getGroupInfo(jid) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  const meta = await sock.groupMetadata(jid);
  const lidMapping = sock.signalRepository?.lidMapping;
  const participants = [];
  for (const p of meta.participants || []) {
    const entry = { id: p.id, admin: p.admin || null };
    if (p.id?.endsWith('@lid') && lidMapping?.getPNForLID) {
      try {
        const pn = await lidMapping.getPNForLID(p.id);
        if (pn) entry.phone = pn;
      } catch (e) {
        entry.resolveError = e.message;
      }
    }
    participants.push(entry);
  }
  return { id: meta.id, subject: meta.subject, size: meta.size, participants };
}

// Resolve um telefone em JID/LID: consulta o WhatsApp (onWhatsApp) e o
// mapeamento local LID↔PN. Permite cruzar um número com participantes de
// grupo, que hoje chegam quase sempre como `@lid`.
async function resolvePhone(phone) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  const digits = String(phone).replace(/\D/g, '');
  const out = { phone: digits, exists: null, jid: null, lid: null };
  try {
    const res = await sock.onWhatsApp(digits);
    if (res && res[0]) {
      out.exists = !!res[0].exists;
      out.jid = res[0].jid || null;
      out.lid = res[0].lid || null;
    }
  } catch (e) {
    out.onWhatsAppError = e.message;
  }
  const lidMapping = sock.signalRepository?.lidMapping;
  if (!out.lid && lidMapping?.getLIDForPN) {
    try {
      const lid = await lidMapping.getLIDForPN(`${digits}@s.whatsapp.net`);
      if (lid) out.lid = lid;
    } catch (e) {
      out.lidMappingError = e.message;
    }
  }
  return out;
}

// Atualiza o nome de perfil do próprio bot no WhatsApp.
async function setProfileName(newName) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  await sock.updateProfileName(newName);
  _appendConv('config', `[nome do perfil alterado para "${newName}"]`);
  return { ok: true, name: newName };
}

// Retorna o link de convite (chat.whatsapp.com/<code>) do grupo. Exige que o
// bot seja admin do grupo. Usado quando addParticipants falha por
// account_reachout_restricted — o usuário entra pelo link.
async function getGroupInviteLink(jid) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  const code = await sock.groupInviteCode(jid);
  return { jid, code, url: `https://chat.whatsapp.com/${code}` };
}

// Renomeia um grupo (groupUpdateSubject do Baileys). O bot precisa ser admin.
async function setGroupSubject(jid, subject) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  await sock.groupUpdateSubject(jid, subject);
  _appendConv('config', `[grupo ${jid} renomeado para "${subject}"]`);
  return { ok: true, jid, subject };
}

// Atualiza a descrição de um grupo. O bot precisa ser admin.
async function setGroupDescription(jid, description) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  await sock.groupUpdateDescription(jid, description);
  _appendConv('config', `[grupo ${jid} descrição atualizada]`);
  return { ok: true, jid };
}

// Adiciona/remove/promove/demote participantes. action ∈ add|remove|promote|demote.
async function updateGroupParticipants(jid, participantJids, action) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
    throw new Error(`action inválida: ${action} (use add|remove|promote|demote)`);
  }
  const result = await sock.groupParticipantsUpdate(jid, participantJids, action);
  _appendConv('config', `[grupo ${jid} ${action}: ${participantJids.join(',')}]`);
  return { ok: true, jid, action, result };
}

// Entra num grupo via invite code (parte final do link chat.whatsapp.com/<code>).
async function acceptGroupInvite(inviteCode) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('canal WhatsApp ainda não conectado');
  const groupId = await sock.groupAcceptInvite(inviteCode);
  _appendConv('config', `[entrou no grupo ${groupId} via invite code ${inviteCode}]`);
  return { ok: true, groupId, inviteCode };
}

async function listGroups() {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) throw new Error('WhatsApp não conectado');
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map(g => ({
    id: g.id,
    subject: g.subject,
    participants: g.participants?.length || 0,
    admins: (g.participants || []).filter(p => p.admin).length,
  }));
}

module.exports = {
  sendText, sendVoice, sendVideo, sendDocument,
  setProfilePhoto, setProfileName,
  createGroup, getGroupInfo, getGroupInviteLink, setGroupSubject,
  setGroupDescription, updateGroupParticipants, resolvePhone,
  acceptGroupInvite, listGroups,
};
