'use strict';
// routes/heygen.js — rotas /api/heygen/*: passthrough pra services/media/
// heygen.js (avatares, vozes, vídeos) + pipeline de Reels (heygen-reels),
// com entrega opcional no WhatsApp.

const express = require('express');
const fs = require('fs-extra');
const { _bearerAuth } = require('../lib/bearer-auth');
const heygen = require('../services/media/heygen');
const heygenReels = require('../services/media/heygen-reels');

module.exports = function mount(app, { getWhatsappChannel }) {
  const wa = () => getWhatsappChannel();

// ── HeyGen (avatares, vozes, geração de vídeo) — API v2/v1 ────────────────
app.get('/api/heygen/health', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(await heygen.health());
});

app.get('/api/heygen/avatars', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.listarAvatares());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/heygen/voices', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json({ voices: await heygen.listarVozes() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/heygen/videos', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.listarVideos({ limit: Number(req.query.limit) || 20, token: req.query.token }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/heygen/videos — gera vídeo (assíncrono → { video_id }).
// body: { avatarId?, voiceId?, script?, audioAssetId?, audioUrl?, avatarStyle?, dimension?, background?, title? }
app.post('/api/heygen/videos', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.criarVideo(req.body || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/heygen/videos/:id', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.getStatus(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/heygen/videos/:id', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.cancelarVideo(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/heygen/reels — pipeline E2E de Reels vertical 9:16 (720×1280):
// roteiro → ElevenLabs TTS → uploadAsset → criarVideo → poll → baixarMp4
// → [acelerar ffmpeg]. Síncrono, leva ~70–120s. Opcional: entrega no WhatsApp.
// body: { roteiro, speed?, titulo?, avatarId?, voiceId?, sendTo?, caption? }
app.post('/api/heygen/reels', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { roteiro, speed, titulo, avatarId, voiceId, sendTo, caption } = req.body || {};
  if (!roteiro) return res.status(400).json({ error: 'roteiro is required' });
  req.setTimeout(0); // o pipeline pode levar minutos — sem timeout de resposta
  try {
    const r = await heygenReels.gerarReels({ roteiro, speed, titulo, avatarId, voiceId });
    let delivered = null;
    if (sendTo) {
      if (!wa()) {
        delivered = { ok: false, error: 'WhatsApp channel not enabled' };
      } else {
        const buf = await fs.readFile(r.mp4Path);
        await wa().sendVideo(sendTo, buf, caption || titulo);
        delivered = { ok: true, jid: sendTo, bytes: buf.length };
      }
    }
    res.json({ ...r, delivered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

};
