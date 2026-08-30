'use strict';
// bearer-auth.js — auth por Bearer token das rotas /api/* (comparação em tempo
// constante). Retorna true/false e já responde 401/500 quando falha.

const crypto = require('crypto');

function _bearerAuth(req, res) {
  const expected = process.env.API_BEARER_SECRET
    || process.env.WEBHOOK_CRM_SECRET
    || process.env.WEBHOOK_READAI_SECRET;
  if (!expected) {
    res.status(500).json({ ok: false, error: 'API_BEARER_SECRET nao configurado' });
    return false;
  }
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(presented), b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

module.exports = { _bearerAuth };
