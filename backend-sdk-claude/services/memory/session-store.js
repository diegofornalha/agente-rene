// SQLite-backed write-through cache for session-scoped message logs.
//
// Two consumers today:
//   * SessionContextManager (sessionContext.js, server.js Socket.IO chat)  → scope='context'
//   * conversation-history (services/memory/conversation-history.js, WhatsApp/Telegram) → scope='history:<platform>'
//
// Both keep an in-memory Map as the source of truth for reads. Writes go to the
// Map immediately and are mirrored to SQLite asynchronously, debounced per
// session_id so a burst of appends costs one SQLite write+fsync. On boot,
// rehydrate() loads recent sessions back into the in-memory Map so a PM2
// restart does not drop active conversations.
//
// Default backend is "memory" (current behavior, no SQLite touched). Flip to
// "sqlite" via env to enable persistence:
//   SESSION_STORE_BACKEND=sqlite pm2 restart hermes-mythos-lucas --update-env
//
// Storage shares data/state.db with kanban (WAL mode handles concurrency).

const path = require('path');
const fs = require('fs-extra');
const logger = require('../logger');

const BACKEND = process.env.SESSION_STORE_BACKEND || 'memory';
const DB_FILE = process.env.SESSION_STORE_DB
  || path.join(__dirname, '..', '..', 'data', 'state.db');
const DEBOUNCE_MS = parseInt(process.env.SESSION_STORE_DEBOUNCE_MS || '200', 10);

let db = null;
const _stmts = {};

function _initDb() {
  if (db) return db;
  const Database = require('better-sqlite3');
  fs.ensureDirSync(path.dirname(DB_FILE));
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  // synchronous=NORMAL is the documented sweet spot with WAL: durability up to
  // the last fsync (we never lose committed transactions on crash), without
  // paying for fsync on every transaction. Default FULL adds latency for no
  // benefit when WAL is on.
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      scope         TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      PRIMARY KEY (scope, session_id)
    );

    CREATE TABLE IF NOT EXISTS session_messages (
      id          INTEGER PRIMARY KEY,
      scope       TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      timestamp   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_msgs_lookup
      ON session_messages(scope, session_id, id);

    CREATE INDEX IF NOT EXISTS idx_sessions_recent
      ON sessions(scope, last_activity DESC);
  `);

  _stmts.upsertSession = db.prepare(`
    INSERT INTO sessions (scope, session_id, created_at, last_activity)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope, session_id) DO UPDATE SET last_activity = excluded.last_activity
  `);
  _stmts.insertMsg = db.prepare(`
    INSERT INTO session_messages (scope, session_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  // Keep last N messages per (scope, session_id). Deletes everything older.
  _stmts.trimKeepLastN = db.prepare(`
    DELETE FROM session_messages
    WHERE scope = ? AND session_id = ? AND id <= COALESCE((
      SELECT id FROM session_messages
      WHERE scope = ? AND session_id = ?
      ORDER BY id DESC LIMIT 1 OFFSET ?
    ), -1)
  `);
  _stmts.deleteSessionMsgs = db.prepare(
    `DELETE FROM session_messages WHERE scope = ? AND session_id = ?`
  );
  _stmts.deleteSessionRow = db.prepare(
    `DELETE FROM sessions WHERE scope = ? AND session_id = ?`
  );
  _stmts.recentSessions = db.prepare(
    `SELECT * FROM sessions WHERE scope = ? AND last_activity > ? ORDER BY last_activity DESC`
  );
  _stmts.msgsForSession = db.prepare(
    `SELECT role, content, timestamp FROM session_messages WHERE scope = ? AND session_id = ? ORDER BY id ASC`
  );
  _stmts.staleSessions = db.prepare(
    `SELECT scope, session_id FROM sessions WHERE last_activity < ?`
  );
  _stmts.statsSessions = db.prepare(
    `SELECT scope, COUNT(*) AS n FROM sessions GROUP BY scope`
  );
  _stmts.statsMessages = db.prepare(
    `SELECT scope, COUNT(*) AS n FROM session_messages GROUP BY scope`
  );

  return db;
}

// pending: Map<`${scope}|${sessionId}`, { scope, sessionId, queue: [...], timer, createdAt, maxKeep }>
const _pending = new Map();

function _flushKey(key) {
  const entry = _pending.get(key);
  if (!entry) return;
  _pending.delete(key);
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  const { scope, sessionId, queue, createdAt, maxKeep } = entry;
  if (queue.length === 0) return;

  try {
    _initDb();
    const tx = db.transaction(() => {
      const lastTs = queue[queue.length - 1].timestamp;
      _stmts.upsertSession.run(scope, sessionId, createdAt || lastTs, lastTs);
      for (const m of queue) {
        _stmts.insertMsg.run(scope, sessionId, m.role, m.content, m.timestamp);
      }
      // Guard against negative/NaN maxKeep — SQLite treats OFFSET -1 as error.
      if (typeof maxKeep === 'number' && Number.isFinite(maxKeep) && maxKeep > 0) {
        _stmts.trimKeepLastN.run(scope, sessionId, scope, sessionId, Math.floor(maxKeep));
      }
    });
    tx();
  } catch (e) {
    logger.error({ err: e, op: 'flush', scope, sessionId }, 'session-store flush failed');
  }
}

function persistMessages({ scope, sessionId, messages, createdAt, maxKeep }) {
  if (BACKEND !== 'sqlite') return;
  if (!Array.isArray(messages) || messages.length === 0) return;

  const key = `${scope}|${sessionId}`;
  let entry = _pending.get(key);
  if (!entry) {
    entry = { scope, sessionId, queue: [], timer: null, createdAt, maxKeep };
    _pending.set(key, entry);
  } else {
    // First-seen createdAt wins; maxKeep updates to latest hint
    if (!entry.createdAt && createdAt) entry.createdAt = createdAt;
    if (maxKeep) entry.maxKeep = maxKeep;
  }
  for (const m of messages) {
    entry.queue.push({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || Date.now(),
    });
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => _flushKey(key), DEBOUNCE_MS);
}

// Convenience for single-message appends.
function persistMessage(opts) {
  persistMessages({
    scope: opts.scope,
    sessionId: opts.sessionId,
    messages: [{ role: opts.role, content: opts.content, timestamp: opts.timestamp }],
    createdAt: opts.createdAt,
    maxKeep: opts.maxKeep,
  });
}

// Returns Map<sessionId, { createdAt, lastActivity, messages: [...] }> for the scope.
function rehydrate({ scope, maxAgeMs }) {
  const out = new Map();
  if (BACKEND !== 'sqlite') return out;
  try {
    _initDb();
    const cutoff = Date.now() - maxAgeMs;
    const rows = _stmts.recentSessions.all(scope, cutoff);
    for (const r of rows) {
      const msgs = _stmts.msgsForSession.all(scope, r.session_id);
      out.set(r.session_id, {
        createdAt: r.created_at,
        lastActivity: r.last_activity,
        messages: msgs.map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
      });
    }
  } catch (e) {
    logger.error({ err: e, op: 'rehydrate', scope }, 'session-store rehydrate failed');
  }
  return out;
}

function purge({ scope, sessionId }) {
  if (BACKEND !== 'sqlite') return;
  const key = `${scope}|${sessionId}`;
  const entry = _pending.get(key);
  if (entry?.timer) clearTimeout(entry.timer);
  _pending.delete(key);
  try {
    _initDb();
    db.transaction(() => {
      _stmts.deleteSessionMsgs.run(scope, sessionId);
      _stmts.deleteSessionRow.run(scope, sessionId);
    })();
  } catch (e) {
    logger.error({ err: e, op: 'purge', scope, sessionId }, 'session-store purge failed');
  }
}

function cleanupStale(maxAgeMs) {
  if (BACKEND !== 'sqlite') return 0;
  try {
    _initDb();
    const cutoff = Date.now() - maxAgeMs;
    const stale = _stmts.staleSessions.all(cutoff);
    if (stale.length === 0) return 0;
    db.transaction(() => {
      for (const s of stale) {
        _stmts.deleteSessionMsgs.run(s.scope, s.session_id);
        _stmts.deleteSessionRow.run(s.scope, s.session_id);
      }
    })();
    return stale.length;
  } catch (e) {
    logger.error({ err: e, op: 'cleanupStale' }, 'session-store cleanupStale failed');
    return 0;
  }
}

function flushAll() {
  for (const key of [..._pending.keys()]) _flushKey(key);
}

// Used by shutdown hooks: drains in-flight writes then closes the SQLite
// handle so the WAL checkpoint runs before SIGKILL. Idempotent.
function shutdown() {
  try { flushAll(); } catch (e) {
    logger.error({ err: e, op: 'shutdown:flushAll' }, 'session-store shutdown flush failed');
  }
  if (db) {
    try { db.close(); } catch (e) {
      logger.error({ err: e, op: 'shutdown:close' }, 'session-store db.close failed');
    }
    db = null;
  }
}

function stats() {
  if (BACKEND !== 'sqlite') return { backend: BACKEND, pending: _pending.size };
  try {
    _initDb();
    const sessions = _stmts.statsSessions.all();
    const messages = _stmts.statsMessages.all();
    return { backend: BACKEND, pending: _pending.size, sessions, messages };
  } catch (e) {
    return { backend: BACKEND, error: e.message };
  }
}

// Drain on graceful shutdown. PM2 sends SIGINT/SIGTERM; we have 10s before SIGKILL.
// shutdown() flushes AND closes the db so WAL checkpoint runs to completion.
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('beforeExit', shutdown);

module.exports = {
  BACKEND,
  persistMessage,
  persistMessages,
  rehydrate,
  purge,
  cleanupStale,
  flushAll,
  shutdown,
  stats,
  _initDb,
};
