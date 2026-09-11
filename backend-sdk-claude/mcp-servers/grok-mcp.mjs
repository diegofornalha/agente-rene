#!/usr/bin/env node
// grok-mcp.mjs — servidor MCP (stdio) que dá ao agente René uma tool para
// perguntar ao Grok, reaproveitando o grok-bot (/workspace/grok-bot):
// conecta no Chrome já logado no grok.com via CDP, faz UMA pergunta e devolve
// a resposta. Não usa a API paga do x.ai.
//
// Registrado em claude-mcp-servers.json -> o CLI do Claude Code spawnado pelo
// backend (claude-query.js, --mcp-config) expõe a tool ao modelo `rene`.
//
// Estado: cada chamada abre uma aba nova, pergunta, e FECHA a aba (não acumula
// abas nem derruba o Chrome — connectOverCDP apenas desconecta). Sem
// continuidade de conversa entre chamadas por padrão.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Libs do grok-bot (CommonJS). Caminho absoluto: não depende do cwd.
const GROK_BOT = process.env.GROK_BOT_DIR || '/workspace/grok-bot';
const { loadPlaywright } = require(`${GROK_BOT}/lib/deps.js`);
const { detectarPorta } = require(`${GROK_BOT}/lib/chrome.js`);
const { Grok } = require(`${GROK_BOT}/lib/grok.js`);

// Faz uma pergunta ao Grok e devolve a resposta como string.
async function perguntarGrok({ pergunta, novo_chat = false, porta = null }) {
  const alvo = porta || detectarPorta().porta;
  if (!alvo) {
    throw new Error(
      'Nenhum Chrome com sessão logada no grok.com foi encontrado. ' +
        'Abra o grok.com num perfil do Chrome com --remote-debugging-port e faça login, ' +
        'ou passe a porta em "porta".'
    );
  }

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${alvo}`);
  let grok;
  try {
    grok = await Grok.abrir(browser);
    if (novo_chat) await grok.novoChat();
    const resposta = await grok.perguntar(pergunta);
    return { resposta, url: grok.url(), porta: alvo };
  } finally {
    // fecha só a aba que abrimos; desconecta sem matar o Chrome do usuário
    try { if (grok && grok.page) await grok.page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

const TOOL = {
  name: 'perguntar_ao_grok',
  description:
    'Faz uma pergunta ao Grok (grok.com) usando a sessão do Chrome já logada nesta máquina ' +
    'e devolve a resposta em texto. Útil para consultar o Grok / xAI sem API paga. ' +
    'Cada chamada é independente (sem memória de conversa), a menos que você não peça novo_chat.',
  inputSchema: {
    type: 'object',
    properties: {
      pergunta: {
        type: 'string',
        description: 'A pergunta ou mensagem a enviar ao Grok.',
      },
      novo_chat: {
        type: 'boolean',
        description: 'Se true, inicia uma conversa nova (zera o contexto) antes de perguntar.',
        default: false,
      },
      porta: {
        type: 'number',
        description: 'Porta CDP do Chrome, se a detecção automática falhar (ex.: 9255).',
      },
    },
    required: ['pergunta'],
  },
};

const server = new Server(
  { name: 'grok-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL.name) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool desconhecida: ${req.params.name}` }],
    };
  }
  const args = req.params.arguments || {};
  if (!args.pergunta || typeof args.pergunta !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Parâmetro "pergunta" (string) é obrigatório.' }],
    };
  }
  try {
    const { resposta, url } = await perguntarGrok(args);
    return { content: [{ type: 'text', text: `${resposta}\n\n[conversa: ${url}]` }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Erro ao consultar o Grok: ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr para não poluir o canal stdio (JSON-RPC) do protocolo
process.stderr.write('[grok-mcp] servidor MCP pronto (tool: perguntar_ao_grok)\n');
