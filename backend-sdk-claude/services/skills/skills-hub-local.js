// Skills Hub local — lê índices do Hermes upstream e expõe via REST.
//
// Lê 4 índices JSON do Hermes Agent clone em hermes-agent/skills/index-cache/:
//   - anthropics_skills_skills_.json
//   - claude_marketplace_anthropics_skills.json
//   - lobehub_index.json
//   - openai_skills_skills_.json
//
// Endpoints:
//   GET /api/skills-hub/search?q=<query>&source=<source>&limit=<n>
//   GET /api/skills-hub/sources
//   GET /api/skills-hub/install/<source>/<name> — download e instalar localmente
//
// blueprint: hermes-agent/tools/skills_hub.py (3.443 linhas — SkillsHub class)

const fs = require('fs-extra');
const path = require('path');

const INDEX_DIR = path.join(__dirname, '..', '..', 'hermes-agent', 'skills', 'index-cache');
const SKILLS_ROOT = path.join(__dirname, '..', '..', '.claude', 'skills');
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'skills-hub-cache.json');
const CACHE_TTL = 3600_000; // 1h

// ── Load & cache ───────────────────────────────────────────────────────────

let _cache = null;
let _cacheAt = 0;

function _loadIndices() {
  if (_cache && (Date.now() - _cacheAt) < CACHE_TTL) return _cache;

  const sources = ['anthropics', 'claude_marketplace', 'lobehub', 'openai'];
  const indexNames = [
    'anthropics_skills_skills_.json',
    'claude_marketplace_anthropics_skills.json',
    'lobehub_index.json',
    'openai_skills_skills_.json',
  ];

  _cache = [];
  for (let i = 0; i < sources.length; i++) {
    const idxFile = path.join(INDEX_DIR, indexNames[i]);
    if (!fs.existsSync(idxFile)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
      const src = sources[i];
      for (const skill of (Array.isArray(data) ? data : [])) {
        _cache.push({ ...skill, _source: src });
      }
    } catch (_) {}
  }

  _cacheAt = Date.now();
  return _cache;
}

// ── Search ────────────────────────────────────────────────────────────────

function search(query, options = {}) {
  const { source, limit = 20 } = options;
  const all = _loadIndices();
  let results = all;

  if (source) {
    results = results.filter(s => s._source === source);
  }

  if (query) {
    const q = query.toLowerCase();
    results = results.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      (s.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  return results.slice(0, limit).map(s => ({
    name: s.name,
    description: s.description?.slice(0, 200),
    source: s._source,
    trust_level: s.trust_level,
    tags: s.tags || [],
    identifier: s.identifier,
  }));
}

function listSources() {
  const all = _loadIndices();
  const counts = {};
  for (const s of all) {
    counts[s._source] = (counts[s._source] || 0) + 1;
  }
  return Object.entries(counts).map(([name, count]) => ({ name, count }));
}

// ── Install (baixo o capô — baixa skill pra .claude/skills/) ──────────────

async function installSkill(source, name) {
  // Por ora, só retorna info — instalação real requer git clone ou download.
  // O Hermes upstream usa `skills install <name>` com git.
  const all = _loadIndices();
  const skill = all.find(s => s._source === source && s.name === name);
  if (!skill) throw new Error(`Skill "${name}" não encontrada em ${source}`);

  const destDir = path.join(SKILLS_ROOT, name);
  fs.ensureDirSync(destDir);

  const content = [
    '---',
    `name: ${skill.name}`,
    `description: ${(skill.description || '').slice(0, 200)}`,
    `source: hub:${source}`,
    `trust_level: ${skill.trust_level || 'community'}`,
    `tags: [${(skill.tags || []).join(', ')}]`,
    '---',
    '',
    skill.description || '',
    '',
    `*Instalado do Hermes Skills Hub (${source}) — ID: ${skill.identifier}*`,
  ].join('\n');

  fs.writeFileSync(path.join(destDir, 'SKILL.md'), content, 'utf8');
  return { installed: true, path: destDir };
}

// ── Express routes ────────────────────────────────────────────────────────

function routes(app) {
  app.get('/api/skills-hub/search', (req, res) => {
    const { q, source, limit } = req.query;
    try {
      const results = search(q, { source, limit: parseInt(limit) || 20 });
      res.json({ results, total: results.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/skills-hub/sources', (req, res) => {
    res.json({ sources: listSources() });
  });

  app.post('/api/skills-hub/install/:source/:name', async (req, res) => {
    const { source, name } = req.params;
    try {
      const result = await installSkill(decodeURIComponent(source), decodeURIComponent(name));
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { search, listSources, installSkill, routes };