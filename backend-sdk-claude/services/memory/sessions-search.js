// Sessions FTS5 — espelha tasks (data/tasks.json) em uma tabela FTS5 do
// SQLite pra busca full-text rápida. Sincroniza no boot + a cada save.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');

const DB_FILE = path.join(__dirname, '..', '..', 'data', 'state.db');
fs.ensureDirSync(path.dirname(DB_FILE));

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
    id UNINDEXED,
    prompt,
    result,
    source UNINDEXED,
    tags,
    status UNINDEXED,
    created_at UNINDEXED,
    tokenize = 'unicode61'
  );
`);

// Sincroniza um lote de tasks (chamado no boot e a cada _save do task-runner).
function syncFromTasks(tasks) {
  const tx = db.transaction((batch) => {
    const del = db.prepare('DELETE FROM tasks_fts WHERE id = ?');
    const ins = db.prepare(`INSERT INTO tasks_fts (id, prompt, result, source, tags, status, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const t of batch) {
      del.run(t.id);
      ins.run(
        t.id,
        t.prompt || '',
        t.result || '',
        t.source || 'api',
        (t.tags || []).join(' '),
        t.status || '',
        t.createdAt || Date.now(),
      );
    }
  });
  tx(tasks);
}

function search(query, { limit = 20, source, status } = {}) {
  let sql = `SELECT id, snippet(tasks_fts, 1, '«', '»', '…', 16) AS snippet,
                    source, status, created_at AS createdAt
             FROM tasks_fts WHERE tasks_fts MATCH ?`;
  const params = [query];
  if (source) { sql += ' AND source = ?'; params.push(source); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// Boot sync — popula a partir de data/tasks.json se a tabela estiver vazia.
function bootSync() {
  const count = db.prepare('SELECT count(*) AS n FROM tasks_fts').get().n;
  if (count > 0) {
    console.log(`🔎 Sessions FTS5: ${count} entries já indexadas`);
    return;
  }
  const tasksFile = path.join(__dirname, '..', '..', 'data', 'tasks.json');
  if (!fs.existsSync(tasksFile)) return;
  try {
    const tasks = fs.readJsonSync(tasksFile);
    syncFromTasks(tasks);
    console.log(`🔎 Sessions FTS5: indexadas ${tasks.length} tasks`);
  } catch (e) {
    console.error('FTS5 boot sync failed:', e.message);
  }
}

bootSync();

module.exports = { search, syncFromTasks };
