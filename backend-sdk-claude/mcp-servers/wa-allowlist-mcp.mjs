#!/usr/bin/env node
// wa-allowlist-mcp.mjs — servidor MCP (stdio) para o agente operar o WhatsApp do
// Hermes Agent a partir da própria conversa:
//   - allowlist (WHATSAPP_ALLOWED_USERS em ~/.hermes/.env) + restart do gateway
//   - limpar o contexto (sessões do gateway em ~/.hermes/state.db) de um contato
//     e avisá-lo pela ponte do WhatsApp (127.0.0.1:3000/send)
//
// Registrado em claude-mcp-servers-dm.json -> exposto ao modelo `rene-dm`.
// Segurança: PIN opcional. Se WA_ALLOWLIST_PIN (env) estiver definido, toda operação
// que altera algo exige esse PIN; se não estiver, as operações rodam sem PIN (a
// allowlist do WhatsApp já restringe quem consegue falar com o agente).
// Listar nunca exige PIN.

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
const PIN = (process.env.WA_ALLOWLIST_PIN || '').trim();
const KEY = 'WHATSAPP_ALLOWED_USERS';
const EXEC_ENV = { ...process.env, PATH: `${HOME}/.local/bin:${process.env.PATH || ''}` };

function log(msg) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function normalizarNumero(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) {
    throw new Error(`Número inválido: "${n}". Use DDI+DDD+número, só dígitos (ex.: 5511999999999).`);
  }
  return d;
}

function exigirPin(pin) {
  if (!PIN) return; // PIN desativado: nada a validar
  if (String(pin || '').trim() !== PIN) {
    log('PIN incorreto');
    throw new Error('PIN incorreto. Operação recusada.');
  }
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

function reiniciarGateway() {
  try {
    execFileSync('pm2', ['restart', PM2_APP, '--update-env'], { env: EXEC_ENV, stdio: 'pipe', timeout: 60000 });
    return `gateway "${PM2_APP}" reiniciado`;
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
    description: 'Adiciona um número à allowlist do WhatsApp do Hermes e reinicia o gateway. Use quando o dono pedir para liberar/autorizar um número.',
    inputSchema: {
      type: 'object',
      required: ['numero'],
      properties: {
        numero: { type: 'string', description: 'Número com DDI, só dígitos (ex.: 5516992294486)' },
        pin: { type: 'string', description: 'PIN de autorização; só necessário se o servidor estiver configurado com PIN' },
      },
    },
  },
  {
    name: 'whatsapp_allowlist_remover',
    description: 'Remove um número da allowlist do WhatsApp do Hermes e reinicia o gateway.',
    inputSchema: {
      type: 'object',
      required: ['numero'],
      properties: { numero: { type: 'string' }, pin: { type: 'string' } },
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
        pin: { type: 'string', description: 'Só necessário se o servidor estiver configurado com PIN' },
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
      exigirPin(args.pin);
      const num = normalizarNumero(args.numero);
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
      const num = args.numero ? normalizarNumero(args.numero) : null;
      const rows = listarSessoes(num);
      if (!rows.length) return ok(num ? `Nenhuma sessão para ${num}.` : 'Nenhuma sessão WhatsApp em DM.');
      const linhas = rows.map((r) => `- ${r.telefone} | ${r.mensagens} msgs | última: ${r.ultima} | id ${r.id} | "${r.titulo || ''}"`);
      return ok(`Sessões WhatsApp (${rows.length}):\n${linhas.join('\n')}`);
    }

    if (name === 'whatsapp_limpar_contexto') {
      exigirPin(args.pin);
      const num = normalizarNumero(args.numero);
      const rows = listarSessoes(num);
      if (!rows.length) return ok(`Nenhuma sessão encontrada para ${num}. Nada apagado.`);
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
      const msg = `Contexto de ${num} limpo. Sessões apagadas: ${apagadas.join(', ')}. ${avisoMsg}.`;
      log(`${name} ${num} -> ${msg}`);
      return ok(msg);
    }

    throw new Error(`Ferramenta desconhecida: ${name}`);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Erro: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
