const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const MEMORY_DIR = path.join(__dirname, '..', '..', 'data', 'memory');

fs.ensureDirSync(MEMORY_DIR);

function _filePath(key) {
  return path.join(MEMORY_DIR, `${key}.json`);
}

function _sha256(content) {
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

// Lê uma entrada. Retorna { content, sha256 } ou null.
function read(key) {
  try {
    const data = fs.readJsonSync(_filePath(key));
    return { content: data.content, sha256: data.sha256 };
  } catch {
    return null;
  }
}

// Escreve com controle de concorrência (precondition).
// precondition=null → força escrita (primeira vez).
// precondition=sha256 → só grava se hash atual bater.
// Retorna { ok, sha256 } ou { ok: false, reason }
function write(key, content, precondition = null) {
  const existing = read(key);

  if (precondition !== null) {
    const currentHash = existing?.sha256 ?? null;
    if (currentHash !== precondition) {
      return { ok: false, reason: 'hash_mismatch', current: currentHash };
    }
  }

  const sha256 = _sha256(content);
  fs.writeJsonSync(_filePath(key), { key, content, sha256, updatedAt: Date.now() }, { spaces: 2 });
  return { ok: true, sha256 };
}

// Append seguro a uma lista (lê → modifica → escreve com precondition).
// Retry automático em hash_mismatch (race condition entre writers concorrentes).
function append(key, item, maxItems = 200) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const existing = read(key);
    const list = existing?.content ?? [];
    const sha256 = existing?.sha256 ?? null;

    const updated = [...list, { ...item, at: Date.now() }].slice(-maxItems);
    const result = write(key, updated, sha256);
    if (result.ok) return result;

    if (result.reason === 'hash_mismatch' && attempt < MAX_RETRIES - 1) {
      continue; // re-read e tenta de novo
    }
    return result;
  }
}

// Lista todas as chaves disponíveis.
function keys() {
  try {
    return fs.readdirSync(MEMORY_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch { return []; }
}

// Lê múltiplas chaves de uma vez.
function readMany(keyList) {
  const result = {};
  for (const k of keyList) {
    const entry = read(k);
    if (entry) result[k] = entry.content;
  }
  return result;
}

// ── Markdown memory files no padrão Hermes Agent ──────────────────────────
// MEMORY.md (~2,200 chars / ~800 tokens) — fatos do ambiente, convenções, etc.
// USER.md   (~1,375 chars / ~500 tokens) — perfil do usuário e preferências.
// Snapshot frozen, injetado no system prompt a cada task.

const MD_LIMITS = {
  'SOUL.md':   1500,
  'MEMORY.md': 2200,
  'USER.md':   1375,
};

function _mdPath(filename) {
  return path.join(MEMORY_DIR, filename);
}

function readMd(filename) {
  try {
    return fs.readFileSync(_mdPath(filename), 'utf8');
  } catch { return ''; }
}

function writeMd(filename, content) {
  fs.ensureDirSync(MEMORY_DIR);
  let text = String(content || '').trim();
  const limit = MD_LIMITS[filename];
  if (limit && text.length > limit) {
    console.warn(`⚠️  ${filename} excede ${limit} chars (atual: ${text.length}) — truncando.`);
    text = text.slice(0, limit);
  }
  fs.writeFileSync(_mdPath(filename), text + '\n', 'utf8');
  return { ok: true, length: text.length };
}

// Snapshot pra injetar no system prompt.
function snapshotMd() {
  return {
    soul:   readMd('SOUL.md').trim(),
    memory: readMd('MEMORY.md').trim(),
    user:   readMd('USER.md').trim(),
  };
}

// ── Memória isolada por peer (inspirado em Honcho/retaindb do Hermes Agent) ──
// data/memory/peers/<name>.md   — fatos sobre uma pessoa específica
// data/memory/peers/_shared.md  — fatos válidos pra todos os interlocutores
// Limites: peer 2500 chars (~900 tokens), shared 1500 chars.
const PEER_LIMITS = { _shared: 1500, _default: 2500 };
const PEERS_DIR = path.join(MEMORY_DIR, 'peers');

function _peerPath(name) {
  const safe = String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!safe) return null;
  return path.join(PEERS_DIR, `${safe}.md`);
}

function readPeerMd(name) {
  const p = _peerPath(name);
  if (!p) return '';
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function writePeerMd(name, content) {
  const p = _peerPath(name);
  if (!p) return { ok: false, reason: 'invalid_peer_name' };
  fs.ensureDirSync(PEERS_DIR);
  const limit = PEER_LIMITS[name.toLowerCase()] ?? PEER_LIMITS._default;
  let text = String(content || '').trim();
  if (text.length > limit) {
    console.warn(`⚠️  peers/${name}.md excede ${limit} chars (atual: ${text.length}) — truncando.`);
    text = text.slice(0, limit);
  }
  fs.writeFileSync(p, text + '\n', 'utf8');
  return { ok: true, length: text.length };
}

function appendToPeerMd(name, line) {
  const current = readPeerMd(name);
  const bullet = line.startsWith('- ') ? line : `- ${line}`;
  if (current.includes(bullet)) return { ok: true, dedup: true, length: current.length };
  const next = current.trimEnd() + '\n' + bullet + '\n';
  return writePeerMd(name, next);
}

function listPeers() {
  try {
    return fs.readdirSync(PEERS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch { return []; }
}

// Snapshot **peer-aware** — injeta só o peer-file relevante + shared.
// Fallback ao USER.md se peer for null/desconhecido (compat retroativo).
function snapshotMdForPeer(peerName) {
  const peer = peerName ? String(peerName).toLowerCase() : null;
  const peerContent = peer ? readPeerMd(peer).trim() : '';
  const shared = readPeerMd('_shared').trim();

  return {
    soul:   readMd('SOUL.md').trim(),
    memory: readMd('MEMORY.md').trim(),
    shared,
    peer: peerContent,
    peerName: peer,
    // fallback compatibilidade: se peer desconhecido, usa USER.md legacy
    user: peerContent ? '' : readMd('USER.md').trim(),
  };
}

// Append uma linha (bullet) ao fim do arquivo. Se a linha já existir, é no-op.
function appendToMd(filename, line) {
  const current = readMd(filename);
  const bullet = line.startsWith('- ') ? line : `- ${line}`;
  if (current.includes(bullet)) return { ok: true, dedup: true, length: current.length };
  const next = current.trimEnd() + '\n' + bullet + '\n';
  return writeMd(filename, next);
}

// Substitui a primeira linha que contém `oldSubstr` por `newLine`. No-op se não achar.
function replaceLineInMd(filename, oldSubstr, newLine) {
  const current = readMd(filename);
  const lines = current.split('\n');
  const idx = lines.findIndex(l => l.includes(oldSubstr));
  if (idx === -1) return { ok: false, reason: 'not_found' };
  lines[idx] = newLine.startsWith('- ') ? newLine : `- ${newLine}`;
  return writeMd(filename, lines.join('\n'));
}

// Remove linhas que contenham `substr`. Útil pra "esquece X".
function removeLineFromMd(filename, substr) {
  const current = readMd(filename);
  const lines = current.split('\n');
  const filtered = lines.filter(l => !l.includes(substr));
  if (filtered.length === lines.length) return { ok: false, reason: 'not_found' };
  return writeMd(filename, filtered.join('\n'));
}

module.exports = {
  read, write, append, keys, readMany,
  readMd, writeMd, snapshotMd,
  appendToMd, replaceLineInMd, removeLineFromMd,
  // peer-scoped (Honcho-style)
  readPeerMd, writePeerMd, appendToPeerMd, listPeers, snapshotMdForPeer,
};
