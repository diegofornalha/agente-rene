/**
 * providers.js — lista ordenada de provedores do backend e corrente de fallback.
 *
 * providers.json (ao lado do server): [{ name, type: "claude"|"openai", priority, ... }]
 *  - type "claude": o modelo já existe no backend (claudecode, agente…); só entra na corrente.
 *  - type "openai": endpoint compatível com OpenAI (xAI, ou o `hermes proxy` da grokbot-1):
 *    base_url, model (id no provedor), key_env (variável com a chave) ou key (literal).
 *    Sem chave, só fica disponível quando o base_url é local (127.0.0.1/localhost), que é o caso
 *    do proxy do Hermes: ele aceita qualquer bearer e usa o OAuth da xAI por baixo.
 *
 * Corrente: o modelo pedido primeiro; se falhar ANTES de produzir texto, desce para o próximo
 * disponível por prioridade. O cliente é avisado por um chunk com `x_meu_bot.fallback`.
 * Mesmo arquivo em backend-colima/ e backend-vm/services/ (copiar, não editar só um).
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const DEFAULT_PROVIDERS = [
  { name: 'agente', type: 'claude', priority: 0, description: 'Claude Code com ferramentas, sem pedir permissão' },
  { name: 'grok-4', type: 'openai', priority: 1, base_url: 'https://api.x.ai/v1', model: 'grok-4', key_env: 'XAI_API_KEY', description: 'Grok da xAI (endpoint compatível com OpenAI)' },
];

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().toLowerCase();
  const type = String(raw.type || '').trim().toLowerCase();
  if (!NAME_RE.test(name) || (type !== 'claude' && type !== 'openai')) return null;
  const priority = Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 100;
  const p = { name, type, priority, description: typeof raw.description === 'string' ? raw.description : '' };
  if (type === 'openai') {
    p.base_url = String(raw.base_url || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(p.base_url)) return null;
    p.model = String(raw.model || name);
    if (typeof raw.key_env === 'string') p.key_env = raw.key_env;
    if (typeof raw.key === 'string') p.key = raw.key;
    p.timeout_ms = Number.isFinite(Number(raw.timeout_ms)) ? Number(raw.timeout_ms) : 120000;
  }
  return p;
}

/** Lê providers.json (ou usa o padrão), valida cada entrada e ordena por prioridade. */
function load(file, env = process.env, log = () => {}) {
  let list = DEFAULT_PROVIDERS;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('não é uma lista');
    list = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') log(`providers.json ignorado (${e.message}); usando o padrão`);
  }
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const p = normalize(raw);
    if (p === null) { log(`provedor inválido ignorado: ${JSON.stringify(raw).slice(0, 120)}`); continue; }
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  out.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return out.map((p) => ({ ...p, available: available(p, env) }));
}

const isLocalUrl = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u);

function resolveKey(p, env = process.env) {
  if (p.key) return p.key;
  if (p.key_env && env[p.key_env]) return env[p.key_env];
  return '';
}

/** claude: sempre. openai: precisa de chave, exceto endpoint local (proxy do Hermes aceita qualquer bearer). */
function available(p, env = process.env) {
  if (p.type === 'claude') return true;
  return Boolean(p.base_url) && (resolveKey(p, env) !== '' || isLocalUrl(p.base_url));
}

const byName = (providers, name) => providers.find((p) => p.name === name) || null;

/**
 * Ordem de tentativa para o modelo pedido: ele primeiro, depois os outros disponíveis por
 * prioridade. Modelo fora da lista → [] (sem fallback; o backend roda como sempre).
 */
function chain(providers, requested) {
  const first = byName(providers, requested);
  if (first === null) return [];
  return [first.name, ...providers.filter((p) => p.name !== requested && p.available).map((p) => p.name)];
}

/** Entradas para GET /v1/models: só os openai disponíveis (os claude o backend já lista). */
const openaiModels = (providers) => providers.filter((p) => p.type === 'openai' && p.available);

/** Chunk SSE que avisa o cliente da troca de provedor (delta vazio; o aviso vai em x_meu_bot). */
function fallbackChunk(id, created, model, from, to, reason) {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
    x_meu_bot: { fallback: { from, to, reason: String(reason || '').slice(0, 300) } },
  };
}

function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

/**
 * Chat completion num endpoint compatível com OpenAI, em stream. onDelta recebe texto incremental.
 * Resolve {text, usage, deltas}. Rejeita com Error({code: 'upstream_<status>'|'upstream_conn'|'upstream_timeout'|'aborted'}).
 */
function openaiCompletion({ provider, env = process.env, messages, signal, onDelta }) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${provider.base_url}/chat/completions`);
    const key = resolveKey(provider, env);
    const body = JSON.stringify({
      model: provider.model,
      stream: true,
      messages: messages
        .filter((m) => m && typeof m.role === 'string' && messageText(m))
        .map((m) => ({ role: m.role, content: messageText(m) })),
    });
    const mod = url.protocol === 'https:' ? https : http;
    let finished = false; let text = ''; let deltas = 0; let usage = null; let buf = ''; let idle = null;
    const fail = (code, msg) => { if (finished) return; finished = true; if (idle) clearTimeout(idle); const e = new Error(msg); e.code = code; reject(e); try { req.destroy(); } catch (_) {} };
    const bump = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => fail('upstream_timeout', `${provider.name} ficou ${provider.timeout_ms / 1000}s sem responder`), provider.timeout_ms); };
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body), ...(key || isLocalUrl(provider.base_url) ? { Authorization: `Bearer ${key || 'local'}` } : {}) },
    }, (res) => {
      bump();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errBody = '';
        res.on('data', (c) => { errBody += c.toString('utf8'); });
        res.on('end', () => {
          let msg = errBody.slice(0, 300);
          try { const j = JSON.parse(errBody); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch (_) {}
          fail(`upstream_${res.statusCode}`, `${provider.name} respondeu ${res.statusCode}: ${msg || 'sem detalhes'}`);
        });
        return;
      }
      const isSse = String(res.headers['content-type'] || '').includes('text/event-stream');
      const handle = (block) => {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          let ch; try { ch = JSON.parse(data); } catch (_) { continue; }
          if (ch.error && ch.error.message && !text) { fail('upstream_error', `${provider.name}: ${ch.error.message}`); return; }
          const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
          if (d && typeof d.content === 'string' && d.content) { text += d.content; deltas++; if (onDelta) onDelta(d.content); }
          if (ch.usage) usage = { input_tokens: ch.usage.prompt_tokens || 0, output_tokens: ch.usage.completion_tokens || 0 };
        }
      };
      res.on('data', (c) => {
        bump();
        buf += c.toString('utf8');
        if (!isSse) return;
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) { handle(buf.slice(0, sep)); buf = buf.slice(sep + 2); }
      });
      res.on('end', () => {
        if (finished) return;
        if (isSse) { if (buf.trim()) handle(buf); }
        else {
          try { const j = JSON.parse(buf); const c = j.choices && j.choices[0]; text = (c && c.message && c.message.content) || ''; if (j.usage) usage = { input_tokens: j.usage.prompt_tokens || 0, output_tokens: j.usage.completion_tokens || 0 }; } catch (_) {}
        }
        finished = true; if (idle) clearTimeout(idle);
        if (!text) { const e = new Error(`${provider.name} terminou sem texto`); e.code = 'upstream_empty'; return reject(e); }
        resolve({ text, usage, deltas });
      });
      res.on('error', (e) => fail('upstream_conn', `${provider.name}: ${e.message}`));
    });
    req.on('error', (e) => fail('upstream_conn', `${provider.name} inacessível (${e.code || e.message})`));
    if (signal) {
      const onAbort = () => fail('aborted', 'cliente fechou a conexão');
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    bump();
    req.end(body);
  });
}

module.exports = { load, chain, available, byName, openaiModels, fallbackChunk, openaiCompletion, resolveKey, DEFAULT_PROVIDERS };
