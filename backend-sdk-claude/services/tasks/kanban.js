// Kanban Multi-Agent — coordenação de N sub-agentes via taskRunner.
// Persistência em SQLite (data/state.db). Cards têm status: backlog,
// in_progress, blocked, done. Cada card pode disparar uma task no taskRunner.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const DB_FILE = path.join(__dirname, '..', '..', 'data', 'state.db');
fs.ensureDirSync(path.dirname(DB_FILE));

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS kanban_cards (
    id            TEXT PRIMARY KEY,
    board         TEXT NOT NULL DEFAULT 'default',
    title         TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'backlog',  -- backlog|in_progress|blocked|done
    assignee      TEXT,                              -- profile/agent name
    task_id       TEXT,                              -- task no taskRunner que está executando
    priority      INTEGER NOT NULL DEFAULT 0,
    tags_json     TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    finished_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(board, status);
  CREATE INDEX IF NOT EXISTS idx_kanban_priority ON kanban_cards(priority DESC);
`);

let _taskRunner = null;

function _row(c) {
  return c ? {
    id: c.id, board: c.board, title: c.title, description: c.description,
    status: c.status, assignee: c.assignee, taskId: c.task_id,
    priority: c.priority, tags: JSON.parse(c.tags_json || '[]'),
    createdAt: c.created_at, updatedAt: c.updated_at, finishedAt: c.finished_at,
  } : null;
}

function start({ taskRunner }) {
  _taskRunner = taskRunner;
  console.log('🗂️  Kanban: SQLite em', DB_FILE);
}

function createCard({ board = 'default', title, description, assignee, priority = 0, tags = [] }) {
  if (!title) throw new Error('title obrigatório');
  const now = Date.now();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO kanban_cards (id, board, title, description, status, assignee, priority, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?)
  `).run(id, board, title, description || null, assignee || null, priority, JSON.stringify(tags), now, now);
  return _row(getCard(id));
}

function getCard(id) {
  return _row(db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id));
}

function listCards({ board = 'default', status } = {}) {
  const sql = status
    ? 'SELECT * FROM kanban_cards WHERE board = ? AND status = ? ORDER BY priority DESC, created_at ASC'
    : 'SELECT * FROM kanban_cards WHERE board = ? ORDER BY priority DESC, created_at ASC';
  const rows = status
    ? db.prepare(sql).all(board, status)
    : db.prepare(sql).all(board);
  return rows.map(_row);
}

function moveCard(id, status) {
  const allowed = ['backlog', 'in_progress', 'blocked', 'done'];
  if (!allowed.includes(status)) throw new Error(`status inválido: ${status}`);
  const finishedAt = status === 'done' ? Date.now() : null;
  db.prepare('UPDATE kanban_cards SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?')
    .run(status, Date.now(), finishedAt, id);
  return getCard(id);
}

// Dispara o card como task no taskRunner — sai pro in_progress
function dispatchCard(id, { workspace, model, agent } = {}) {
  if (!_taskRunner) throw new Error('Kanban: taskRunner não inicializado');
  const card = getCard(id);
  if (!card) throw new Error('card não encontrado');
  if (card.taskId) throw new Error('card já tem task associada');

  const prompt = card.description
    ? `${card.title}\n\n${card.description}`
    : card.title;
  const task = _taskRunner.createTask({
    prompt,
    source: `kanban:${card.board}`,
    tags: ['kanban', `card:${id}`, ...(card.tags || [])],
    workspace,
    model,
    agent: agent || card.assignee || undefined,
    maxTurns: 12,
  });
  db.prepare('UPDATE kanban_cards SET status = ?, task_id = ?, updated_at = ? WHERE id = ?')
    .run('in_progress', task.id, Date.now(), id);
  return { card: getCard(id), task };
}

function deleteCard(id) {
  const res = db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id);
  return { ok: res.changes > 0 };
}

module.exports = { start, createCard, getCard, listCards, moveCard, dispatchCard, deleteCard };
