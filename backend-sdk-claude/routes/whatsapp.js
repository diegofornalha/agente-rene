'use strict';
// routes/whatsapp.js — rotas /api/whatsapp/*: envio direto (texto/voz/vídeo/
// documento), contexto de conversa, allowlist de DM, grupos e perfil do bot.
// O canal é lazy (só existe com WHATSAPP_ENABLED=true) — acessado via
// getWhatsappChannel() a cada request.

const express = require('express');
const fs = require('fs-extra');
const { _bearerAuth } = require('../lib/bearer-auth');
const convHistory = require('../services/memory/conversation-history');
const logger = require('../services/logger');

module.exports = function mount(app, { getWhatsappChannel, sessionContextManager }) {
  const wa = () => getWhatsappChannel();

// ── WhatsApp envio direto (texto ou áudio TTS) ────────────────────────────
app.post('/api/whatsapp/say', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { jid, text, voice } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: 'jid and text are required' });
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    if (voice) await wa().sendVoice(jid, text);
    else await wa().sendText(jid, text);
    res.json({ success: true, mode: voice ? 'voice' : 'text' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/send-video — envia um MP4 local como mídia no WhatsApp.
app.post('/api/whatsapp/send-video', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { jid, videoPath, caption } = req.body || {};
  if (!jid || !videoPath) return res.status(400).json({ error: 'jid and videoPath are required' });
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const buf = await fs.readFile(videoPath);
    await wa().sendVideo(jid, buf, caption);
    res.json({ success: true, bytes: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/send-document — envia documento (PDF, DOCX, etc) via WhatsApp.
app.post('/api/whatsapp/send-document', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { jid, filePath, filename, mimetype, caption } = req.body || {};
  if (!jid || !filePath) return res.status(400).json({ error: 'jid and filePath are required' });
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const buf = await fs.readFile(filePath);
    const fname = filename || require('path').basename(filePath);
    const mime = mimetype || (filePath.endsWith('.pdf') ? 'application/pdf' : filePath.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/octet-stream');
    await wa().sendDocument(jid, buf, fname, mime, caption);
    res.json({ success: true, bytes: buf.length, filename: fname });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/whatsapp/context/:jid — limpa histórico de conversa (conversation-history + sessionContext).
app.delete('/api/whatsapp/context/:jid', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { jid } = req.params;
  const cleared = { convHistory: false, sessionContext: false };

  // 1. conversation-history (multi-turno wa:jid)
  try {
    convHistory.clearSession('wa', jid);
    cleared.convHistory = true;
  } catch (e) {
    logger.error({ err: e }, `clear convHistory failed for ${jid}`);
  }

  // 2. sessionContext (prompt context)
  try {
    sessionContextManager.clearContext(jid);
    cleared.sessionContext = true;
  } catch (e) {
    logger.error({ err: e }, `clear sessionContext failed for ${jid}`);
  }

  logger.info(`🧹 [CONTEXT] Cleared WhatsApp context for ${jid} — conv=${cleared.convHistory} session=${cleared.sessionContext}`);
  res.json({ success: true, jid, cleared });
});

// GET /api/whatsapp/context/stats — estatísticas dos contextos ativos.
app.get('/api/whatsapp/context/stats', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json({
    convHistory: convHistory.stats(),
    sessionContext: sessionContextManager.getStats(),
  });
});

// GET /api/whatsapp/inbound-image — caminho da última imagem recebida.
app.get('/api/whatsapp/inbound-image', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const imagePath = await wa().getLatestInboundImage();
    res.json({ imagePath: imagePath || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/groups — lista todos os grupos em que o bot participa.
app.get('/api/whatsapp/groups', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const groups = await wa().listGroups();
    res.json({ total: groups.length, groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/dm-allowlist — lista a allowlist de DM (env + runtime + efetiva).
app.get('/api/whatsapp/dm-allowlist', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  res.json(wa().listDmAllowed());
});

// POST /api/whatsapp/dm-allow — libera um número OU LID pra conversar por DM.
// body: { number } (aceita +55…, com pontuação, ou um LID; é normalizado pra dígitos)
app.post('/api/whatsapp/dm-allow', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { number } = req.body || {};
  if (!number) return res.status(400).json({ error: 'number is required' });
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  const r = wa().addDmAllowed(number);
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/whatsapp/dm-disallow — revoga um número/LID adicionado em runtime.
// body: { number }  (não remove entradas fixas do .env)
app.post('/api/whatsapp/dm-disallow', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { number } = req.body || {};
  if (!number) return res.status(400).json({ error: 'number is required' });
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  const r = wa().removeDmAllowed(number);
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/whatsapp/create-group — cria grupo e retorna metadata.
// body: { subject, participants?: string[] }
app.post('/api/whatsapp/create-group', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { subject, participants } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'subject é obrigatório' });
    const meta = await wa().createGroup(subject, participants || []);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/group-open — marca um grupo como observado + aberto (responde
// a TODOS os membros, sem precisar de @), em RUNTIME e sem reiniciar o backend.
// body: { jid, open?: boolean = true, name? }
app.post('/api/whatsapp/group-open', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  const { jid, open = true, name } = req.body || {};
  if (!jid) return res.status(400).json({ error: 'jid é obrigatório' });
  try {
    wa().addObservedGroup(jid, name, { open });
    res.json({ ok: true, jid, open });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/group-info/:jid — metadata do grupo + resolve LID→telefone via USync.
// Útil pra descobrir telefones de participantes que só aparecem como `@lid`.
app.get('/api/whatsapp/group-info/:jid', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const info = await wa().getGroupInfo(req.params.jid);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/resolve/:phone — telefone → { exists, jid, lid } via
// onWhatsApp + mapeamento LID↔PN. Cruza com participantes `@lid` dos grupos.
app.get('/api/whatsapp/resolve/:phone', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const info = await wa().resolvePhone(req.params.phone);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/group-info/:jid/invite — link de convite do grupo (bot precisa ser admin).
// Útil quando addParticipants falha por account_reachout_restricted.
app.get('/api/whatsapp/group-info/:jid/invite', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const link = await wa().getGroupInviteLink(req.params.jid);
    res.json(link);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/group-join — entra num grupo via invite code. body: { inviteCode }
app.post('/api/whatsapp/group-join', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { inviteCode } = req.body || {};
    if (!inviteCode) return res.status(400).json({ error: 'inviteCode é obrigatório' });
    const result = await wa().acceptGroupInvite(inviteCode);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/whatsapp/group-info/:jid/subject — renomeia grupo. body: { subject }
app.patch('/api/whatsapp/group-info/:jid/subject', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { subject } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'subject é obrigatório' });
    const out = await wa().setGroupSubject(req.params.jid, subject);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/whatsapp/group-info/:jid/description — atualiza descrição. body: { description }
app.patch('/api/whatsapp/group-info/:jid/description', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { description } = req.body || {};
    if (!description) return res.status(400).json({ error: 'description é obrigatório' });
    const out = await wa().setGroupDescription(req.params.jid, description);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/group-info/:jid/participants — body: { participants: [...], action: add|remove|promote|demote }
app.post('/api/whatsapp/group-info/:jid/participants', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { participants, action } = req.body || {};
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'participants[] obrigatório' });
    }
    if (!action) return res.status(400).json({ error: 'action obrigatório (add|remove|promote|demote)' });
    const out = await wa().updateGroupParticipants(req.params.jid, participants, action);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/profile-photo — troca a foto de perfil do bot.
// body: { imagePath? } — sem imagePath, usa a última imagem recebida no WhatsApp.
app.post('/api/whatsapp/profile-photo', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    let imagePath = req.body && req.body.imagePath;
    if (!imagePath) imagePath = await wa().getLatestInboundImage();
    if (!imagePath) {
      return res.status(404).json({ error: 'nenhuma imagem disponível — envie uma imagem no WhatsApp ou passe imagePath' });
    }
    const r = await wa().setProfilePhoto(imagePath);
    res.json({ ...r, imagePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/profile-name — troca o nome de perfil do bot.
app.post('/api/whatsapp/profile-name', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!wa()) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'campo "name" obrigatório' });
    const r = await wa().setProfileName(name);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

};
