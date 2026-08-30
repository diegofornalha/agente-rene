'use strict';
// routes/roleplay.js — role-play comercial: consultor treina contra personas
// de lead e um avaliador pontua pela rubrica do Playbook (services/roleplay/).

const { _bearerAuth } = require('../lib/bearer-auth');

module.exports = function mount(app) {

// ── Role-Play Comercial — treino de consultores contra personas de lead ──
// MVP em texto: consultor conversa com o Hiperagente-Lead e um Hiperagente
// avaliador pontua pela rubrica do Playbook. Lógica em services/roleplay/.
const roleplay = require('../services/roleplay');

app.get('/api/roleplay/personas', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(roleplay.listPersonas());
});

app.post('/api/roleplay/start', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(await roleplay.start(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/roleplay/turn', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(await roleplay.turn(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/roleplay/end', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(roleplay.end(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/roleplay/evaluate', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(await roleplay.evaluate(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/roleplay/sessions', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(roleplay.listSessions());
});

app.get('/api/roleplay/session/:id', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(roleplay.getSession(req.params.id));
});

};
