'use strict';
// dm-allowlist.js — allowlist de DM (números OU LIDs, só dígitos).
// Conjunto efetivo = WHATSAPP_ALLOWED_NUMBERS (.env, seed fixo do boot) ∪
// adições de runtime (via API/skill), persistidas em
// data/whatsapp-dm-allowlist.json — sem editar .env nem reiniciar.

const path = require('path');
const fs = require('fs-extra');

const DM_ALLOWLIST_PATH = path.join(__dirname, '..', '..', 'data', 'whatsapp-dm-allowlist.json');
const dmAllowExtra = new Set();

function _normalizeNumber(n) {
  return String(n || '').replace(/\D/g, '');
}

function _parseAllowed() {
  const raw = process.env.WHATSAPP_ALLOWED_NUMBERS || '';
  return raw.split(',').map(s => _normalizeNumber(s)).filter(Boolean);
}

function _loadDmAllowlist() {
  try {
    const arr = JSON.parse(fs.readFileSync(DM_ALLOWLIST_PATH, 'utf8'));
    if (Array.isArray(arr)) arr.forEach(n => { const d = _normalizeNumber(n); if (d) dmAllowExtra.add(d); });
  } catch (_) { /* arquivo não existe ainda — ok */ }
}

function _saveDmAllowlist() {
  fs.writeFile(DM_ALLOWLIST_PATH, JSON.stringify([...dmAllowExtra], null, 2)).catch(e =>
    console.error('dm allowlist save failed:', e.message));
}

// Conjunto efetivo = entradas do .env ∪ adições de runtime.
function _allowedSet() {
  return new Set([..._parseAllowed(), ...dmAllowExtra]);
}

function _isAllowed(jid) {
  const set = _allowedSet();
  if (set.size === 0) return true; // lista totalmente vazia = libera todos
  return set.has(_normalizeNumber(jid.split('@')[0]));
}

// API pública pra gerenciar a allowlist de DM em runtime.
function addDmAllowed(entry) {
  const d = _normalizeNumber(entry);
  if (!d) return { ok: false, error: 'número/LID inválido (vazio após normalizar)' };
  const already = _allowedSet().has(d);
  dmAllowExtra.add(d);
  _saveDmAllowlist();
  console.log(`✅ DM allowlist: + ${d}${already ? ' (já permitido)' : ''}`);
  return { ok: true, entry: d, alreadyAllowed: already, effectiveTotal: _allowedSet().size };
}

function removeDmAllowed(entry) {
  const d = _normalizeNumber(entry);
  if (!d) return { ok: false, error: 'número/LID inválido' };
  const removedFromRuntime = dmAllowExtra.delete(d);
  if (removedFromRuntime) _saveDmAllowlist();
  const stillInEnv = _parseAllowed().includes(d);
  console.log(`🗑️  DM allowlist: - ${d} (runtime=${removedFromRuntime}, ainda no .env=${stillInEnv})`);
  return { ok: true, entry: d, removedFromRuntime, stillInEnv };
}

function listDmAllowed() {
  return { env: _parseAllowed(), runtime: [...dmAllowExtra], effective: [..._allowedSet()] };
}

module.exports = {
  _normalizeNumber,
  _loadDmAllowlist,
  _isAllowed,
  addDmAllowed,
  removeDmAllowed,
  listDmAllowed,
};
