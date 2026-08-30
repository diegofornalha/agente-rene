// Skill Curator avançado — reescrito do zero com transições automáticas,
// snapshot pré-run, LLM consolidation pass, e REPORT.md timestamped.
//
// blueprint: hermes-agent/agent/curator.py (apply_automatic_transitions, CURATOR_REVIEW_PROMPT)
//            hermes-agent/tools/skill_usage.py (skill_usage table, state machine)
//
// Funcionalidades:
// - Tabela skill_usage em data/state.db (state, pinned, created_by, timestamps, counters)
// - Phase 1: transições automáticas (active→stale→archive) sem LLM
// - Phase 2: snapshot pré-run em .claude/skills/.backups/<ISO>/
// - Phase 3: LLM consolidation pass (umbrella-building)
// - Phase 4: REPORT.md timestamped em data/curator/REPORT-<ISO>.md
// - Trigger automático via cron (7d idle + 1h sem task)

const fs = require('fs-extra');
const path = require('path');
const { openDb } = require('../db/sqlite');

const SKILLS_ROOT   = path.join(__dirname, '..', '..', '.claude', 'skills');
const STATE_DB      = path.join(__dirname, '..', '..', 'data', 'state.db');
const REPORT_DIR    = path.join(__dirname, '..', '..', 'data', 'curator');
const BACKUP_ROOT   = path.join(SKILLS_ROOT, '.backups');
const REPORT_FILE   = (iso) => path.join(REPORT_DIR, `REPORT-${iso}.md`);
const STALE_DAYS    = parseInt(process.env.CURATOR_STALE_DAYS    || '30');
const ARCHIVE_DAYS   = parseInt(process.env.CURATOR_ARCHIVE_DAYS   || '90');
const INTERVAL_HRS   = parseInt(process.env.CURATOR_INTERVAL_HOURS || '168');

let _db = null;

function _getDb() {
  if (!_db) {
    _db = openDb(STATE_DB);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS skill_usage (
        name TEXT PRIMARY KEY,
        state TEXT DEFAULT 'active' CHECK(state IN ('active','stale','archived')),
        pinned INTEGER DEFAULT 0,
        created_by TEXT DEFAULT 'user',
        created_at INTEGER,
        last_activity_at INTEGER,
        view_count INTEGER DEFAULT 0,
        use_count INTEGER DEFAULT 0,
        patch_count INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0
      );
    `);
  }
  return _db;
}

// ── CRUD skill_usage ────────────────────────────────────────────────────────

function bumpView(name) {
  const db = _getDb();
  db.prepare('INSERT INTO skill_usage (name, view_count) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET view_count = view_count + 1').run(name);
}

function bumpUse(name, costUSD = 0) {
  const db = _getDb();
  const now = Date.now();
  db.prepare('INSERT INTO skill_usage (name, use_count, cost_usd, last_activity_at) VALUES (?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET use_count = use_count + 1, cost_usd = cost_usd + ?, last_activity_at = ?').run(name, costUSD, costUSD, now);
}

function bumpPatch(name) {
  const db = _getDb();
  db.prepare('INSERT INTO skill_usage (name, patch_count) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET patch_count = patch_count + 1').run(name);
}

function setState(name, state) {
  const db = _getDb();
  db.prepare('INSERT INTO skill_usage (name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = ?').run(name, state, state);
}

function markPinned(name, pinned = true) {
  const db = _getDb();
  db.prepare('UPDATE skill_usage SET pinned = ? WHERE name = ?').run(pinned ? 1 : 0, name);
}

function report() {
  const db = _getDb();
  return db.prepare('SELECT * FROM skill_usage ORDER BY last_activity_at DESC NULLS LAST').all();
}

// ── Helpers de arquivo ───────────────────────────────────────────────────────

function _listSkillDirs() {
  const result = [];
  if (!fs.existsSync(SKILLS_ROOT)) return result;
  for (const entry of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const skillDir = path.join(SKILLS_ROOT, entry.name);
      const stat = fs.statSync(skillDir);
      result.push({
        name: entry.name,
        dir: skillDir,
        mtime: stat.mtimeMs,
        ageDays: Math.floor((Date.now() - stat.mtimeMs) / 86400000),
      });
    }
  }
  return result;
}

function _readSkillMeta(name) {
  const mdPath = path.join(SKILLS_ROOT, name, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return {};
  const content = fs.readFileSync(mdPath, 'utf8');
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const obj = {};
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) obj[m[1]] = m[2].trim();
  }
  return obj;
}

function _ensureBackupDir(iso) {
  const dir = path.join(BACKUP_ROOT, iso);
  fs.ensureDirSync(dir);
  return dir;
}

function _snapshotBackup(iso) {
  const backupDir = _ensureBackupDir(iso);
  const skills = _listSkillDirs();
  const snapDir = path.join(backupDir, 'skills');
  fs.ensureDirSync(snapDir);
  for (const s of skills) {
    const dest = path.join(snapDir, s.name);
    fs.ensureDirSync(dest);
    for (const f of fs.readdirSync(s.dir)) {
      fs.copyFileSync(path.join(s.dir, f), path.join(dest, f));
    }
  }
  // Mantém só os últimos 10 backups
  const backups = fs.readdirSync(BACKUP_ROOT).sort();
  while (backups.length > 10) {
    fs.removeSync(path.join(BACKUP_ROOT, backups.shift()));
  }
  return snapDir;
}

// ── Phase 1: transições automáticas ────────────────────────────────────────

function _phase1_transitions() {
  const now = Date.now();
  const staleMs = STALE_DAYS  * 86400000;
  const archMs  = ARCHIVE_DAYS * 86400000;
  const staleCutoff = now - staleMs;
  const archCutoff  = now - archMs;

  const db = _getDb();
  const skills = _listSkillDirs();
  const counters = { checked: 0, marked_stale: 0, archived: 0, reactivated: 0 };

  for (const s of skills) {
    counters.checked++;
    const row = db.prepare('SELECT * FROM skill_usage WHERE name = ?').get(s.name);
    if (row?.pinned) continue;

    const anchor = row?.last_activity_at || (row?.created_at) || s.mtime;
    const state  = row?.state || 'active';

    if (anchor < archCutoff && state !== 'archived') {
      // Arquiva
      const destDir = path.join(SKILLS_ROOT, '.archive');
      fs.ensureDirSync(destDir);
      fs.renameSync(s.dir, path.join(destDir, s.name));
      db.prepare('INSERT INTO skill_usage (name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = ?').run(s.name, 'archived', 'archived');
      counters.archived++;
    } else if (anchor < staleCutoff && state === 'active') {
      db.prepare('INSERT INTO skill_usage (name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = ?').run(s.name, 'stale', 'stale');
      counters.marked_stale++;
    } else if (anchor >= staleCutoff && state === 'stale') {
      db.prepare('UPDATE skill_usage SET state = ? WHERE name = ?').run('active', s.name);
      counters.reactivated++;
    }
  }
  return counters;
}

// ── Phase 3: LLM consolidation (spawna task) ───────────────────────────────

const CURATOR_REVIEW_PROMPT = `You are Hermes' background skill CURATOR running a consolidation pass.

GOAL: Build a LIBRARY OF CLASS-LEVEL INSTRUCTIONS. Not hundreds of narrow skills.
One broad umbrella with subsections beats five narrow siblings.

SIGNALS to act on:
  • Overlapping skills with similar purpose
  • Skills that should be merged under an umbrella
  • Skills that should be pruned (superseded, wrong, too narrow)
  • Missing subsections in existing umbrellas

Produce YAML output:
\`\`\`yaml
consolidations:
  - action: merge
    from: [skill-a, skill-b]
    into: umbrella-name
    reason: "..."
  - action: create-umbrella
    name: umbrella-name
    includes: [skill-c, skill-d]
    reason: "..."
prunings:
  - name: skill-to-remove
    reason: "..."
\`\`\`

If nothing needs changing, output: "Nothing to consolidate."`;

async function _phase3_llm(taskRunner) {
  const candidates = _listSkillDirs().map(s => ({
    name: s.name,
    ageDays: s.ageDays,
    meta: _readSkillMeta(s.name),
  }));

  if (candidates.length === 0) return null;

  const yamlList = candidates.map(c => `- ${c.name} (${c.ageDays}d)`).join('\n');
  const prompt = `Skills candidates:\n${yamlList}\n\n---\n\n${CURATOR_REVIEW_PROMPT}`;

  const task = taskRunner.createTask({
    prompt,
    source: 'curator',
    tags: ['curator-review', 'no-channel-output'],
    allowedTools: ['Read', 'Write', 'Edit'],
    systemPrompt: 'You are the skill curator. Only edit .claude/skills/*. Review and output YAML.',
    maxTurns: 12,
  });

  // Espera conclusão (curator é síncrono).
  let attempts = 0;
  while (attempts < 60) {
    const t = taskRunner.getTask(task.id);
    if (!t || t.status === 'done' || t.status === 'error') break;
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }

  return taskRunner.getTask(task.id)?.result || null;
}

// ── Phase 4: REPORT.md ──────────────────────────────────────────────────────

function _phase4_report(iso, phase1Counters, candidates, llmResult) {
  fs.ensureDirSync(REPORT_DIR);
  const md = [
    `# Skill Curator Report — ${iso}`,
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    '## Phase 1 — Transições automáticas',
    '',
    '| Métrica | Valor |',
    '|---|---|',
    `| Skills verificados | ${phase1Counters.checked} |`,
    `| Marcados stale | ${phase1Counters.marked_stale} |`,
    `| Arquivados | ${phase1Counters.archived} |`,
    `| Reativados | ${phase1Counters.reactivated} |`,
    '',
    '## Phase 3 — LLM Consolidation',
    llmResult ? `\`\`\`\n${llmResult}\n\`\`\`` : 'Nenhuma ação proposta.',
    '',
    '## Skills candidatos',
    candidates.map(c => `- **${c.name}** (${c.ageDays}d) — ${c.meta.description || 'sem descrição'}`).join('\n') || 'Nenhum.',
    '',
  ].join('\n');

  fs.writeFileSync(REPORT_FILE(iso), md, 'utf8');
  return REPORT_FILE(iso);
}

// ── API pública ─────────────────────────────────────────────────────────────

async function run(taskRunner) {
  const iso = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  console.log(`📊 [curator] Starting run at ${iso}`);

  // Snapshot pré-run
  const snapDir = _snapshotBackup(iso);
  console.log(`📦 [curator] Backup snapshot: ${snapDir}`);

  // Phase 1: transições automáticas
  const phase1 = _phase1_transitions();
  console.log(`🔄 [curator] Phase 1: checked=${phase1.checked} stale=${phase1.marked_stale} arch=${phase1.archived}`);

  // Phase 3: LLM consolidation (se taskRunner disponível)
  let llmResult = null;
  if (taskRunner) {
    llmResult = await _phase3_llm(taskRunner).catch(e => {
      console.warn(`⚠️ [curator] Phase 3 failed: ${e.message}`);
      return null;
    });
  }

  // Phase 4: REPORT.md
  const candidates = _listSkillDirs().map(s => ({
    name: s.name,
    ageDays: s.ageDays,
    meta: _readSkillMeta(s.name),
  }));
  const reportPath = _phase4_report(iso, phase1, candidates, llmResult);
  console.log(`📋 [curator] Report: ${reportPath}`);

  return { phase1, llmResult, reportPath };
}

function listReports() {
  if (!fs.existsSync(REPORT_DIR)) return [];
  return fs.readdirSync(REPORT_DIR)
    .filter(f => f.startsWith('REPORT-') && f.endsWith('.md'))
    .map(f => ({ iso: f.replace('REPORT-', '').replace('.md', ''), path: path.join(REPORT_DIR, f) }))
    .sort((a, b) => b.iso.localeCompare(a.iso));
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const taskRunner = require('../tasks/task-runner');
  run(taskRunner).then(r => {
    console.log('✅ Curator done:', JSON.stringify(r.phase1));
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run, listReports, bumpView, bumpUse, bumpPatch, setState, markPinned, report };