// Gerador de índice llms.txt canônico do mythos.
// Sirve como "visão geral" pra outros agentes descobrirem o que o mythos oferece.
//
// blueprint: formato llms.txt do Hermes Agent (https://hermes-agent.nousresearch.com/docs/)
// cache: data/llms-index.json (TTL 60s)

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'llms-index.json');
const CACHE_TTL_MS = 60_000; // 1min

// ── Coleta de dados por seção ─────────────────────────────────────────────

async function _collectEndpoints() {
  const serverPath = path.join(__dirname, '..', '..', 'server.js');
  const content = fs.readFileSync(serverPath, 'utf8');
  const routes = [];
  // Parse app.get/post/put/delete/delete('/path' ...
  const re = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  // Filtra rotas internas (começam com /socket ou internas)
  return routes.filter(r => !r.path.startsWith('/socket') && r.path !== '/');
}

function _collectChannels() {
  const whatsappPath = path.join(__dirname, '..', 'whatsapp', 'whatsapp-channel.js');
  const telegramPath = path.join(__dirname, '..', 'telegram', 'telegram-channel.js');
  const whatsapp = fs.existsSync(whatsappPath);
  const telegram = fs.existsSync(telegramPath);
  const lines = [];
  lines.push(`| Canal | Status | ID padrão |`);
  lines.push(`|---|---|---|`);
  if (whatsapp) lines.push(`| WhatsApp | ✅ ativo | \`WHATSAPP_ENABLED=true\` |`);
  if (telegram) lines.push(`| Telegram | ✅ ativo | \`TELEGRAM_ENABLED=true\` |`);
  return lines.join('\n');
}

async function _collectSkills() {
  const SKILLS_ROOT = path.join(__dirname, '..', '..', '.claude', 'skills');
  const { glob } = require('fs');
  const { promisify } = require('util');
  const globAsync = promisify(glob);
  let skills = [];
  try {
    const files = await globAsync('**/*.md', { cwd: SKILLS_ROOT });
    skills = files
      .map(f => {
        const rel = f.replace(/\.md$/, '').replace(/\\/g, '/');
        const fpath = path.join(SKILLS_ROOT, f);
        const stat = fs.statSync(fpath);
        const age = Math.floor((Date.now() - stat.mtimeMs) / 86400000);
        // Determina estado pelo mtime (simplificado)
        const state = age > 90 ? 'archived' : age > 30 ? 'stale' : 'active';
        return { name: rel, state, mtime: stat.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) {}

  const sections = ['### Skills locais (ativa)', '### Skills stales (>30d)', '### Skills archived (>90d)'];
  const buckets = [[], [], []];
  for (const s of skills) {
    const idx = s.state === 'archived' ? 2 : s.state === 'stale' ? 1 : 0;
    buckets[idx].push(s.name);
  }

  const lines = [];
  for (let i = 0; i < 3; i++) {
    if (buckets[i].length > 0) {
      lines.push(`\n${sections[i]} (${buckets[i].length}):`);
      for (const name of buckets[i]) {
        lines.push(`- \`/${name}\``);
      }
    }
  }
  return lines.join('\n') || 'Nenhuma skill local.';
}

async function _collectCommands() {
  const cmdsPath = path.join(__dirname, '..', '..', '..', '..', '.claude', 'commands');
  let cmds = [];
  try {
    const files = fs.readdirSync(cmdsPath);
    cmds = files.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
  } catch (_) {}

  const lines = [`### Slash commands disponíveis (${cmds.length}):`];
  for (const c of cmds) {
    lines.push(`- \`/${c}\``);
  }
  return lines.join('\n') || 'Nenhum command encontrado.';
}

async function _collectAgents() {
  const agentsPath = path.join(__dirname, '..', '..', '..', 'bridge', 'setup', 'agents');
  let agents = [];
  try {
    const files = fs.readdirSync(agentsPath);
    agents = files.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
  } catch (_) {}

  const lines = [`### Claude Code agents (${agents.length}):`];
  for (const a of agents) {
    lines.push(`- \`${a}\``);
  }
  return lines.join('\n') || 'Nenhum agent configurado.';
}

function _collectMemorySnapshot() {
  const memory = require('../memory/memory-store');
  const snap = memory.snapshotMd();
  const lines = [];
  if (snap.soul) lines.push(`\n### SOUL.md (${snap.soul.length} chars)\n${snap.soul.slice(0, 300)}…`);
  if (snap.user) lines.push(`\n### USER.md (${snap.user.length} chars)\n${snap.user.slice(0, 300)}…`);
  if (snap.memory) lines.push(`\n### MEMORY.md (${snap.memory.length} chars)\n${snap.memory.slice(0, 300)}…`);
  return lines.join('\n') || '(memória vazia)';
}

function _collectHooks() {
  const hooksPath = path.join(__dirname, '..', '..', 'data', 'hooks');
  let hooks = [];
  try {
    hooks = fs.readdirSync(hooksPath)
      .filter(f => f.endsWith('.js') && !f.startsWith('_') && !f.endsWith('.disabled'));
  } catch (_) {}

  const lines = [`### Hooks ativos (${hooks.length}):`];
  for (const h of hooks) {
    lines.push(`- \`${h}\``);
  }
  return lines.join('\n') || 'Nenhum hook ativo.';
}

async function _collectMcpServers() {
  const mcpPath = path.join(__dirname, '..', '..', 'data', 'mcp-servers.json');
  if (!fs.existsSync(mcpPath)) return 'Nenhum MCP server configurado.';
  try {
    const cfg = fs.readJsonSync(mcpPath);
    const servers = Array.isArray(cfg.servers) ? cfg.servers : Object.keys(cfg);
    const lines = [`### MCP servers (${servers.length}):`];
    for (const s of servers) {
      const name = typeof s === 'string' ? s : s.name || '?';
      lines.push(`- \`${name}\``);
    }
    return lines.join('\n');
  } catch (_) {
    return 'Nenhum MCP server configurado.';
  }
}

// ── Gerador principal ──────────────────────────────────────────────────────

async function generate() {
  const [endpoints, skills, commands, agents, memory, hooks, mcp] = await Promise.all([
    _collectEndpoints(),
    _collectSkills(),
    _collectCommands(),
    _collectAgents(),
    Promise.resolve(_collectMemorySnapshot()),
    Promise.resolve(_collectHooks()),
    _collectMcpServers(),
  ]);

  const updatedAt = new Date().toISOString();

  const md = `# Hermes Mythos — índice canônico

> Gerado em ${updatedAt}. Cache TTL: 60s.
> Backend: Node ${process.version} rodando na porta ${process.env.PORT || 3457}.

## Resumo

Backend Node que orquestra o **Claude Code SDK** via REST/Socket.IO.
Canais: WhatsApp (Baileys) + Telegram. Voice: Whisper local + ElevenLabs (Clone Lucas).

## REST Endpoints

| Método | Path | Descrição |
|---|---|---|
${endpoints.map(e => `| ${e.method} | \`${e.path}\` | — |`).join('\n')}

## Canais de mensagem

${_collectChannels()}

## Skills locais

${skills}

## Slash commands

${commands}

## Claude Code agents

${agents}

## Memory snapshot (frozen)

${memory}

## Hooks ativos

${hooks}

## MCP servers

${mcp}

---

*Índice gerado por \`services/llms-index.js\` — não editar manualmente.*
`;

  return { md, updatedAt, endpoints: endpoints.length };
}

// ── Cache ─────────────────────────────────────────────────────────────────

async function get(cacheHint = null) {
  try {
    const cached = fs.readJsonSync(CACHE_PATH);
    if (cached && (Date.now() - cached._cachedAt) < CACHE_TTL_MS) {
      return cached.md;
    }
  } catch (_) {}

  const result = await generate();
  fs.writeJsonSync(CACHE_PATH, { md: result.md, _cachedAt: Date.now(), updatedAt: result.updatedAt }, { spaces: 2 });
  return result.md;
}

// Invalida cache (chamado quando algo muda — skills, hooks, etc).
function invalidate() {
  try { fs.removeSync(CACHE_PATH); } catch (_) {}
}

// Versão "full" — mesma coisa por enquanto, mas bisa crescer pra incluir
// exemplos de request/response, schemas, etc.
async function getFull() {
  return get(); // por ora, full = same
}

module.exports = { get, getFull, invalidate, generate };