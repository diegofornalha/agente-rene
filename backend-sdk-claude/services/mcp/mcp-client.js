// MCP client — conecta a servidores MCP (Model Context Protocol) configurados
// em data/mcp-servers.json e expõe suas tools agregadas. O Claude Code SDK
// já tem sua própria pipeline de MCP via ~/.claude.json — este módulo é o
// "MCP server registry" do mythos pra integrações futuras (HTTP/REST).
//
// Formato data/mcp-servers.json:
// {
//   "servers": [
//     { "name": "github", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {...} },
//     { "name": "memory", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
//     { "name": "twenty", "transport": "http", "url": "https://...", "headers": { "Authorization": "Bearer ..." } }
//   ]
// }

const fs = require('fs-extra');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'data', 'mcp-servers.json');

const _clients = new Map(); // name → { config, client, tools }

function listConfigured() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return [];
    return fs.readJsonSync(CONFIG_FILE).servers || [];
  } catch (e) {
    console.error('mcp-client: failed to read config:', e.message);
    return [];
  }
}

async function _connect(serverConfig) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

  let transport;
  if (serverConfig.transport === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: { ...process.env, ...(serverConfig.env || {}) },
    });
  } else if (serverConfig.transport === 'http') {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
      requestInit: { headers: serverConfig.headers || {} },
    });
  } else {
    throw new Error(`transport não suportado ainda: ${serverConfig.transport}`);
  }

  const client = new Client(
    { name: 'hermes-mythos', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  const toolsResp = await client.listTools().catch(() => ({ tools: [] }));
  return { client, tools: toolsResp.tools || [] };
}

async function start() {
  const servers = listConfigured();
  if (servers.length === 0) {
    console.log('🔌 MCP: nenhum servidor configurado (data/mcp-servers.json vazio/ausente)');
    return;
  }
  for (const cfg of servers) {
    try {
      const { client, tools } = await _connect(cfg);
      _clients.set(cfg.name, { config: cfg, client, tools });
      console.log(`🔌 MCP: ${cfg.name} conectado (${tools.length} tools)`);
    } catch (e) {
      console.error(`❌ MCP ${cfg.name} falhou:`, e.message);
    }
  }
}

function listConnected() {
  return [..._clients.entries()].map(([name, c]) => ({
    name,
    transport: c.config.transport,
    tools: c.tools.map(t => ({ name: t.name, description: t.description })),
  }));
}

async function callTool(serverName, toolName, args = {}) {
  const entry = _clients.get(serverName);
  if (!entry) throw new Error(`MCP server "${serverName}" não conectado`);
  return entry.client.callTool({ name: toolName, arguments: args });
}

async function stop() {
  for (const [name, entry] of _clients) {
    try { await entry.client.close(); } catch {}
    console.log(`🔌 MCP: ${name} desconectado`);
  }
  _clients.clear();
}

module.exports = { start, stop, listConfigured, listConnected, callTool };
