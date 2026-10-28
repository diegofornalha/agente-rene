/**
 * session-map.js — mapa conversa → sessão do Claude Code, para retomar com --resume em vez de
 * reachatar o histórico. Opt-in por cabeçalho X-Conversation-Id; sem ele nada aqui é usado.
 *
 * Armazenamento: data/openai-compat-sessions.json (JSON pequeno, escrita atômica). Sem SQLite de
 * propósito: o better-sqlite3 depende da ABI do Node de produção e já deu dor de cabeça aqui.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE = process.env.OPENAI_COMPAT_SESSIONS_PATH || path.join(__dirname, '..', 'data', 'openai-compat-sessions.json');
const TTL_MS = Math.max(1, parseFloat(process.env.OPENAI_COMPAT_SESSION_TTL_H || '6')) * 3600 * 1000;

let cache = null; // { [key]: { sessionId, cwd, mcpConfigPath, sysHash, seen, createdAt, updatedAt } }
const locks = new Map(); // key → Promise (fila por conversa)

function _load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    cache = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

function _save() {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    const tmp = `${STORE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: cache || {} }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STORE);
  } catch (e) {
    console.warn(`[session-map] falha ao gravar: ${e.message}`);
  }
}

function purge() {
  const entries = _load();
  const now = Date.now();
  let removed = 0;
  for (const [key, e] of Object.entries(entries)) {
    if (!e || typeof e.updatedAt !== 'number' || now - e.updatedAt > TTL_MS) { delete entries[key]; removed++; }
  }
  if (removed) _save();
  return removed;
}

function get(key) {
  purge();
  const e = _load()[key];
  return e ? { ...e } : null;
}

function put(key, entry) {
  const entries = _load();
  const prev = entries[key];
  entries[key] = { ...entry, createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now() };
  _save();
}

function del(key) {
  const entries = _load();
  if (key in entries) { delete entries[key]; _save(); }
}

const PROJECTS_BASE = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

/** Diretório de projetos do Claude Code: cwd com "/" e "." trocados por "-". */
function projectDir(cwd) {
  return path.join(PROJECTS_BASE, String(cwd).replace(/[/.]/g, '-'));
}

function sessionFileExists(cwd, sessionId) {
  if (!cwd || !sessionId || !/^[A-Za-z0-9-]{8,}$/.test(String(sessionId))) return false;
  try { return fs.statSync(path.join(projectDir(cwd), `${sessionId}.jsonl`)).isFile(); } catch (_) { return false; }
}

/** Serializa trabalho por chave: nunca duas CLIs na mesma sessão. */
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise(r => { release = r; });
  locks.set(key, prev.then(() => mine));
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === mine) locks.delete(key); }
}

/** Só para testes: zera o cache em memória. */
function _reset() { cache = null; locks.clear(); }

module.exports = { get, put, del, purge, sessionFileExists, projectDir, withLock, STORE, TTL_MS, _reset };
