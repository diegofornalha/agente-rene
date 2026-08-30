'use strict';
// group-registry.js — grupos observados (modo passivo) e grupos "abertos"
// (respondem a todos sem @), com persistência em data/whatsapp-groups.json.

const path = require('path');
const fs = require('fs-extra');

// Allowlist de grupos observados (modo passivo — só loga, não responde).
// Formato: grupoJid1,grupoJid2,... (separados por vírgula, sem espaços).
// Alternativa: definir no .env como WHATSAPP_GROUP_ALLOWLIST=120363xxxx@g.us,...
const GROUP_ALLOWLIST_ENV = process.env.WHATSAPP_GROUP_ALLOWLIST || '';
const GROUP_STORE_PATH = path.join(__dirname, '..', '..', 'data', 'whatsapp-groups.json');

// Grupos "abertos": agente responde a TUDO (sem precisar de @ ou menção a René/Hermes).
// Anti-loop e bloqueio de bots conhecidos continuam valendo.
// Config exclusivamente via .env WHATSAPP_OPEN_GROUPS (JIDs separados por vírgula) —
// sem JIDs hardcoded, pra clones/instâncias novas não herdarem grupos alheios.
const OPEN_GROUPS = new Set(
  (process.env.WHATSAPP_OPEN_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// ── Store de grupos observados (persistido em JSON) ──
const observedGroups = new Map(); // groupJid → { name, addedAt }

// Carrega allowlist do .env na inicialização.
function _loadGroupAllowlist() {
  if (GROUP_ALLOWLIST_ENV) {
    GROUP_ALLOWLIST_ENV.split(',').forEach(jid => {
      const g = jid.trim();
      if (g) observedGroups.set(g, { name: g, addedAt: null });
    });
  }
}

// Persiste o map de volta no JSON.
function _saveGroupStore() {
  const obj = Object.fromEntries(
    [...observedGroups.entries()].map(([k, v]) => [k, v])
  );
  fs.writeFile(GROUP_STORE_PATH, JSON.stringify(obj, null, 2)).catch(e =>
    console.error('group store save failed:', e.message)
  );
}

// Carrega do arquivo na inicialização.
function _loadGroupStore() {
  try {
    const raw = fs.readFileSync(GROUP_STORE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      observedGroups.set(k, v);
    }
  } catch (_) { /* arquivo não existe ainda — ok */ }
}

function isGroupObserved(jid) {
  return observedGroups.has(jid);
}

function addObservedGroup(jid, name, { open } = {}) {
  const prev = observedGroups.get(jid) || {};
  const entry = {
    name: name || prev.name || jid,
    addedAt: prev.addedAt || new Date().toISOString(),
  };
  const openVal = open !== undefined ? open : prev.open;
  if (openVal !== undefined) entry.open = openVal;
  observedGroups.set(jid, entry);
  _saveGroupStore();
  return entry;
}

// Marca/desmarca um grupo como "aberto" (responde a todos sem @) em runtime,
// sem restart. Cria a entrada observada se ainda não existir.
function setGroupOpen(jid, open = true) {
  const prev = observedGroups.get(jid) || { name: jid, addedAt: new Date().toISOString() };
  prev.open = open;
  observedGroups.set(jid, prev);
  _saveGroupStore();
  return { jid, open };
}

function removeObservedGroup(jid) {
  observedGroups.delete(jid);
  _saveGroupStore();
}

function listObservedGroups() {
  return [...observedGroups.entries()].map(([jid, v]) => ({ jid, name: v.name, addedAt: v.addedAt }));
}

module.exports = {
  OPEN_GROUPS,
  observedGroups,
  _loadGroupAllowlist,
  _loadGroupStore,
  isGroupObserved,
  addObservedGroup,
  setGroupOpen,
  removeObservedGroup,
  listObservedGroups,
};
