// Registro de leads/clientes para o produto Rota Fiscal.
// Cada pessoa tem: nome, CPF, telefone, email, país-alvo (Paraguai/LLC/REINTEGRA),
// status do processo, dados adicionais, timestamps.
//
// Persistência: SQLite (data/state.db), mesma DB do session-store.
// API: CRUD exposto via router Express (montado em server.js).

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

const DB_FILE = process.env.SESSION_STORE_DB
  || path.join(__dirname, '..', '..', 'data', 'state.db');

let db = null;

function _initDb() {
  if (db) return db;
  const { openDb } = require('../db/sqlite');
  fs.ensureDirSync(path.dirname(DB_FILE));
  db = openDb(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rota_fiscal_leads (
      id            TEXT PRIMARY KEY,
      nome          TEXT NOT NULL,
      cpf           TEXT,
      telefone      TEXT,
      email         TEXT,
      pais_alvo     TEXT,
      pilares       TEXT,
      status        TEXT NOT NULL DEFAULT 'novo',
      etapa_atual   TEXT,
      dados_extras  TEXT,
      notas         TEXT,
      criado_em     TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rfl_telefone ON rota_fiscal_leads(telefone);
    CREATE INDEX IF NOT EXISTS idx_rfl_cpf ON rota_fiscal_leads(cpf);
    CREATE INDEX IF NOT EXISTS idx_rfl_status ON rota_fiscal_leads(status);
  `);
  return db;
}

// ── Helpers ──

function _now() {
  return new Date().toISOString();
}

function _parseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

function _serialize(row) {
  if (!row) return null;
  return {
    ...row,
    pilares: _parseJson(row.pilares),
    dados_extras: _parseJson(row.dados_extras),
  };
}

// ── CRUD ──

function criar(dados) {
  const d = _initDb();
  const id = uuidv4();
  const now = _now();
  const pilares = dados.pilares ? JSON.stringify(dados.pilares) : null;
  const extras = dados.dados_extras ? JSON.stringify(dados.dados_extras) : null;

  d.prepare(`
    INSERT INTO rota_fiscal_leads
      (id, nome, cpf, telefone, email, pais_alvo, pilares, status, etapa_atual, dados_extras, notas, criado_em, atualizado_em)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    dados.nome,
    dados.cpf || null,
    dados.telefone || null,
    dados.email || null,
    dados.pais_alvo || null,
    pilares,
    dados.status || 'novo',
    dados.etapa_atual || null,
    extras,
    dados.notas || null,
    now,
    now
  );

  return buscarPorId(id);
}

function buscarPorId(id) {
  const d = _initDb();
  const row = d.prepare('SELECT * FROM rota_fiscal_leads WHERE id = ?').get(id);
  return _serialize(row);
}

function buscarPorTelefone(telefone) {
  const d = _initDb();
  const rows = d.prepare('SELECT * FROM rota_fiscal_leads WHERE telefone = ?').all(telefone);
  return rows.map(_serialize);
}

function buscarPorCpf(cpf) {
  const d = _initDb();
  const row = d.prepare('SELECT * FROM rota_fiscal_leads WHERE cpf = ?').get(cpf);
  return _serialize(row);
}

function listar({ status, limit = 50, offset = 0 } = {}) {
  const d = _initDb();
  if (status) {
    return d.prepare(
      'SELECT * FROM rota_fiscal_leads WHERE status = ? ORDER BY atualizado_em DESC LIMIT ? OFFSET ?'
    ).all(status, limit, offset).map(_serialize);
  }
  return d.prepare(
    'SELECT * FROM rota_fiscal_leads ORDER BY atualizado_em DESC LIMIT ? OFFSET ?'
  ).all(limit, offset).map(_serialize);
}

function atualizar(id, dados) {
  const d = _initDb();
  const existente = d.prepare('SELECT * FROM rota_fiscal_leads WHERE id = ?').get(id);
  if (!existente) return null;

  const campos = [];
  const valores = [];

  for (const [chave, valor] of Object.entries(dados)) {
    if (['id', 'criado_em'].includes(chave)) continue;
    if (chave === 'pilares' || chave === 'dados_extras') {
      campos.push(`${chave} = ?`);
      valores.push(JSON.stringify(valor));
    } else {
      campos.push(`${chave} = ?`);
      valores.push(valor);
    }
  }

  if (campos.length === 0) return buscarPorId(id);

  campos.push('atualizado_em = ?');
  valores.push(_now());
  valores.push(id);

  d.prepare(`UPDATE rota_fiscal_leads SET ${campos.join(', ')} WHERE id = ?`).run(...valores);
  return buscarPorId(id);
}

function remover(id) {
  const d = _initDb();
  const result = d.prepare('DELETE FROM rota_fiscal_leads WHERE id = ?').run(id);
  return result.changes > 0;
}

function contarPorStatus() {
  const d = _initDb();
  const rows = d.prepare(
    'SELECT status, COUNT(*) as total FROM rota_fiscal_leads GROUP BY status'
  ).all();
  const counts = {};
  for (const r of rows) counts[r.status] = r.total;
  return counts;
}

// ── Express Router ──

function criarRouter() {
  const express = require('express');
  const router = express.Router();

  // POST /api/leads/rota-fiscal — criar lead
  router.post('/', (req, res) => {
    try {
      if (!req.body.nome) {
        return res.status(400).json({ error: 'Campo "nome" é obrigatório' });
      }
      const lead = criar(req.body);
      res.status(201).json(lead);
    } catch (err) {
      logger.error('Erro ao criar lead:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/leads/rota-fiscal — listar leads
  router.get('/', (req, res) => {
    try {
      const { status, limit, offset } = req.query;
      const leads = listar({
        status,
        limit: limit ? parseInt(limit) : 50,
        offset: offset ? parseInt(offset) : 0,
      });
      res.json({ leads, total: leads.length });
    } catch (err) {
      logger.error('Erro ao listar leads:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/leads/rota-fiscal/stats — contagem por status
  router.get('/stats', (req, res) => {
    try {
      res.json(contarPorStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/leads/rota-fiscal/telefone/:telefone — buscar por telefone
  router.get('/telefone/:telefone', (req, res) => {
    try {
      const leads = buscarPorTelefone(req.params.telefone);
      res.json({ leads });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/leads/rota-fiscal/cpf/:cpf — buscar por CPF
  router.get('/cpf/:cpf', (req, res) => {
    try {
      const lead = buscarPorCpf(req.params.cpf);
      if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
      res.json(lead);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/leads/rota-fiscal/:id — buscar por ID
  router.get('/:id', (req, res) => {
    try {
      const lead = buscarPorId(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
      res.json(lead);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/leads/rota-fiscal/:id — atualizar lead
  router.put('/:id', (req, res) => {
    try {
      const lead = atualizar(req.params.id, req.body);
      if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
      res.json(lead);
    } catch (err) {
      logger.error('Erro ao atualizar lead:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/leads/rota-fiscal/:id — remover lead
  router.delete('/:id', (req, res) => {
    try {
      const ok = remover(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Lead não encontrado' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  criar,
  buscarPorId,
  buscarPorTelefone,
  buscarPorCpf,
  listar,
  atualizar,
  remover,
  contarPorStatus,
  criarRouter,
};
