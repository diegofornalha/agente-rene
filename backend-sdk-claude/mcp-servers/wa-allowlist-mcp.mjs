#!/usr/bin/env node
// wa-allowlist-mcp.mjs — servidor MCP (stdio) para o agente operar o WhatsApp do
// Hermes Agent a partir da própria conversa:
//   - allowlist (WHATSAPP_ALLOWED_USERS em ~/.hermes/.env) + restart do gateway
//   - limpar o contexto (sessões do gateway em ~/.hermes/state.db) de um contato
//     e avisá-lo pela ponte do WhatsApp (127.0.0.1:3000/send)
//
// Registrado em claude-mcp-servers-dm.json -> exposto ao modelo `rene-dm`.
// Segurança: sem PIN. A allowlist do WhatsApp já restringe quem consegue falar com o
// agente; o PIN foi removido em 2026-10-03 a pedido do dono. Não reintroduzir.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';

const HOME = process.env.HERMES_USER_HOME || homedir();
const HERMES_HOME = path.join(HOME, '.hermes');
const ENV_FILE = process.env.HERMES_ENV_FILE || path.join(HERMES_HOME, '.env');
const STATE_DB = process.env.HERMES_STATE_DB || path.join(HERMES_HOME, 'state.db');
const LOG_FILE = path.join(HERMES_HOME, 'logs', 'wa-allowlist.log');
const PM2_APP = process.env.HERMES_GATEWAY_PM2_APP || 'hermes-gateway';
const BRIDGE_URL = process.env.HERMES_WA_BRIDGE_URL || 'http://127.0.0.1:3000';
const KEY = 'WHATSAPP_ALLOWED_USERS';
const EXEC_ENV = { ...process.env, PATH: `${HOME}/.local/bin:${process.env.PATH || ''}` };

// Espera (até ~30 s) o gateway terminar um turno em andamento antes de apagar sessão: apagar durante
// um turno faz o Hermes enviar ao contato "No reply: session storage could not be written" (2026-09-13).
async function aguardarTurnoLivre() {
  const gwLog = path.join(HERMES_HOME, 'logs', 'gateway.log');
  for (let i = 0; i < 15; i++) {
    let tail = '';
    try { tail = execFileSync('tail', ['-n', '400', gwLog], { encoding: 'utf8' }); } catch { return 'log indisponível'; }
    const li = tail.lastIndexOf('inbound message:'); const lr = tail.lastIndexOf('response ready:');
    if (li < 0 || lr > li) return i ? `aguardou ${i * 2} s por turno em andamento` : 'sem turno em andamento';
    await new Promise((r) => setTimeout(r, 2000));
  }
  return 'turno ainda em andamento após 30 s (apagando mesmo assim)';
}

function log(msg) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function normalizarNumero(n, { permitirLead = false } = {}) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) {
    throw new Error(`Número inválido: "${n}". Use DDI+DDD+número, só dígitos (ex.: 5511999999999).`);
  }
  // @menção no WhatsApp mostra lead ID (não é 55 com 12 ou 13 dígitos). Não liberar isso.
  if (!permitirLead && !/^55\d{10,11}$/.test(d)) {
    throw new Error('Isso não é telefone. Um @ no WhatsApp mostra o lead ID da pessoa, não o número. Não liberar e não dizer que está fora da allowlist. Liberar só o telefone real (DDI 55, 12 ou 13 dígitos).');
  }
  return d;
}

// ---------------------------------------------------------------- allowlist
function lerLista() {
  const txt = readFileSync(ENV_FILE, 'utf8');
  const m = txt.match(new RegExp(`^${KEY}=(.*)$`, 'm'));
  const lista = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { txt, lista, presente: !!m };
}

function gravarLista(txt, presente, lista) {
  copyFileSync(ENV_FILE, `${ENV_FILE}.bak-${Date.now()}`);
  const linha = `${KEY}=${lista.join(',')}`;
  const novo = presente
    ? txt.replace(new RegExp(`^${KEY}=.*$`, 'm'), linha)
    : `${txt.replace(/\n?$/, '\n')}${linha}\n`;
  writeFileSync(ENV_FILE, novo, { mode: 0o600 });
}

// Turnos de OUTROS chats em andamento? (1) outro processo claude do backend rene-dm vivo
// (fora o pai deste MCP, que é o turno atual) ou (2) mais de um chat com inbound sem
// "response ready" no gateway.log. Reiniciar nessa hora mata o trabalho alheio
// (2026-09-28: derrubou a edição de vídeo da Camila no meio).
function turnosAlheios() {
  const motivos = [];
  try {
    const out = execFileSync('pgrep', ['-f', 'backend-sdk-claude/node_modules/@anthropic-ai/claude-code-linux-x64/claude --output-format'], { stdio: 'pipe' }).toString();
    const outros = out.split('\n').map(Number).filter(p => p && p !== process.ppid);
    if (outros.length) motivos.push(`${outros.length} turno(s) do backend em curso`);
  } catch (_) {}
  try {
    const linhas = readFileSync(path.join(HERMES_HOME, 'logs', 'gateway.log'), 'utf8').split('\n').slice(-600);
    const ultimo = {};
    for (const l of linhas) {
      const m = l.match(/(inbound message|response ready): platform=\w+ (?:user=.*? )?chat=(\S+)/);
      if (m) ultimo[m[2]] = m[1];
    }
    const pendentes = Object.values(ultimo).filter(v => v === 'inbound message').length;
    if (pendentes > 1) motivos.push(`${pendentes} chats aguardando resposta`);
  } catch (_) {}
  return motivos;
}

function esperarGatewayOcioso(maxMs = 8 * 60 * 1000) {
  const ini = Date.now(); let motivos = turnosAlheios();
  const sab = new SharedArrayBuffer(4);
  while (motivos.length && Date.now() - ini < maxMs) {
    Atomics.wait(new Int32Array(sab), 0, 0, 10000);
    motivos = turnosAlheios();
  }
  return { esperouMs: Date.now() - ini, motivos };
}

function reiniciarGateway() {
  const espera = esperarGatewayOcioso();
  const nota = espera.esperouMs > 15000
    ? ` (esperei ${Math.round(espera.esperouMs / 1000)} s para não derrubar turnos em andamento${espera.motivos.length ? '; reiniciei mesmo assim: ' + espera.motivos.join(', ') : ''})`
    : '';
  try {
    execFileSync('pm2', ['restart', PM2_APP, '--update-env'], { env: EXEC_ENV, stdio: 'pipe', timeout: 60000 });
    return `gateway "${PM2_APP}" reiniciado${nota}`;
  } catch (e) {
    return `AVISO: não consegui reiniciar o gateway (${e.message}). Rode: pm2 restart ${PM2_APP} --update-env`;
  }
}

// ---------------------------------------------------------------- sessões
// Lê state.db em modo somente leitura via python3 (sqlite3 já vem no Python;
// o Node 22 não tem sqlite estável). Devolve as sessões WhatsApp em DM.
function listarSessoes(numero = null) {
  const py = `
import sqlite3, json, sys
c = sqlite3.connect('file:${STATE_DB}?mode=ro', uri=True)
q = "select id, session_key, chat_id, message_count, last_activity_at, title from sessions where source='whatsapp' and session_key like 'agent:main:whatsapp:dm:%' order by last_activity_at desc"
rows = []
for r in c.execute(q):
    tel = r[1].split(':')[4] if r[1].count(':') >= 4 else ''
    rows.append({'id': r[0], 'telefone': tel, 'chat_id': r[2], 'mensagens': r[3], 'ultima': r[4], 'titulo': r[5]})
print(json.dumps(rows, ensure_ascii=False))
`;
  const out = execFileSync('python3', ['-c', py], { env: EXEC_ENV, stdio: 'pipe', timeout: 20000 }).toString();
  const rows = JSON.parse(out);
  return numero ? rows.filter((r) => r.telefone === numero) : rows;
}

function apagarSessao(id) {
  execFileSync('hermes', ['sessions', 'delete', id, '--yes'], { env: EXEC_ENV, stdio: 'pipe', timeout: 60000 });
}

async function enviarWhatsapp(numero, message) {
  const res = await fetch(`${BRIDGE_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: `${numero}@s.whatsapp.net`, message }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`ponte respondeu ${res.status}: ${body.slice(0, 200)}`);
  return body;
}

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: 'whatsapp_allowlist_listar',
    description: 'Lista os números autorizados a conversar com o agente no WhatsApp (WHATSAPP_ALLOWED_USERS do Hermes).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'whatsapp_allowlist_liberar',
    description: 'Adiciona um TELEFONE à allowlist do WhatsApp do Hermes e reinicia o gateway. Só telefone real (DDI 55, 12 ou 13 dígitos). Um @ no grupo mostra lead ID, não telefone: não chame esta ferramenta com esse id e não diga que a pessoa está fora da allowlist por causa dele.',
    inputSchema: {
      type: 'object',
      required: ['numero'],
      properties: {
        numero: { type: 'string', description: 'Telefone real com DDI 55, 12 ou 13 dígitos. Nunca um lead ID copiado de uma @menção.' },
      },
    },
  },
  {
    name: 'whatsapp_allowlist_remover',
    description: 'Remove um número da allowlist do WhatsApp do Hermes e reinicia o gateway.',
    inputSchema: {
      type: 'object',
      required: ['numero'],
      properties: { numero: { type: 'string' } },
    },
  },
  {
    name: 'whatsapp_sessoes_listar',
    description: 'Lista as sessões de conversa (contexto) do WhatsApp guardadas pelo gateway do Hermes, com telefone, quantidade de mensagens e última atividade. Use antes de limpar contexto para confirmar o contato certo.',
    inputSchema: {
      type: 'object',
      properties: { numero: { type: 'string', description: 'Opcional: filtrar por telefone (só dígitos, com DDI)' } },
    },
  },
  {
    name: 'whatsapp_limpar_contexto',
    description: 'Apaga o histórico de conversa (sessões do gateway) de um contato do WhatsApp e envia a ele uma mensagem avisando que o contexto foi zerado. Irreversível. Confirme antes com o dono qual contato e qual texto de aviso.',
    inputSchema: {
      type: 'object',
      required: ['numero'],
      properties: {
        numero: { type: 'string', description: 'Telefone do contato, só dígitos, com DDI' },
        aviso: { type: 'string', description: 'Texto da mensagem de aviso. Padrão: "Contexto limpo, pode mandar de novo."' },
        sem_aviso: { type: 'boolean', description: 'true para apagar sem enviar mensagem ao contato' },
      },
    },
  },
];

const server = new Server({ name: 'wa-allowlist', version: '1.2.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  try {
    if (name === 'whatsapp_allowlist_listar') {
      const { lista } = lerLista();
      return ok(lista.length ? `Autorizados (${lista.length}): ${lista.join(', ')}` : 'Allowlist vazia.');
    }

    if (name === 'whatsapp_allowlist_liberar' || name === 'whatsapp_allowlist_remover') {
      const num = normalizarNumero(args.numero, { permitirLead: name === 'whatsapp_allowlist_remover' });
      const { txt, lista, presente } = lerLista();
      let msg;
      if (name === 'whatsapp_allowlist_liberar') {
        if (lista.includes(num)) {
          msg = `${num} já estava autorizado.`;
        } else {
          lista.push(num);
          gravarLista(txt, presente, lista);
          msg = `${num} liberado. ${reiniciarGateway()}.`;
        }
      } else if (!lista.includes(num)) {
        msg = `${num} não estava na lista.`;
      } else {
        gravarLista(txt, presente, lista.filter((x) => x !== num));
        msg = `${num} removido. ${reiniciarGateway()}.`;
      }
      log(`${name} ${num} -> ${msg}`);
      return ok(`${msg} Lista atual: ${lerLista().lista.join(', ') || '(vazia)'}`);
    }

    if (name === 'whatsapp_sessoes_listar') {
      const num = args.numero ? normalizarNumero(args.numero, { permitirLead: true }) : null;
      const rows = listarSessoes(num);
      if (!rows.length) return ok(num ? `Nenhuma sessão para ${num}.` : 'Nenhuma sessão WhatsApp em DM.');
      const linhas = rows.map((r) => `- ${r.telefone} | ${r.mensagens} msgs | última: ${r.ultima} | id ${r.id} | "${r.titulo || ''}"`);
      return ok(`Sessões WhatsApp (${rows.length}):\n${linhas.join('\n')}`);
    }

    if (name === 'whatsapp_limpar_contexto') {
      const num = normalizarNumero(args.numero, { permitirLead: true });
      const rows = listarSessoes(num);
      if (!rows.length) return ok(`Nenhuma sessão encontrada para ${num}. Nada apagado.`);
      const espera = await aguardarTurnoLivre();
      const apagadas = [];
      for (const r of rows) {
        apagarSessao(r.id);
        apagadas.push(`${r.id} (${r.mensagens} msgs)`);
      }
      let avisoMsg = 'sem aviso enviado';
      if (!args.sem_aviso) {
        const texto = (args.aviso || '').trim() || 'Contexto limpo, pode mandar de novo.';
        await enviarWhatsapp(num, texto);
        avisoMsg = `aviso enviado: "${texto}"`;
      }
      const msg = `Contexto de ${num} limpo. Sessões apagadas: ${apagadas.join(', ')}. ${avisoMsg}. (${espera})`;
      log(`${name} ${num} -> ${msg}`);
      return ok(msg);
    }

    throw new Error(`Ferramenta desconhecida: ${name}`);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Erro: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
