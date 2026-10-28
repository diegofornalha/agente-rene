/**
 * openai-compat.js — Endpoint OpenAI-compatível que embrulha o Claude Code CLI.
 *
 * Expõe o modelo "claudecode" via /v1/chat/completions (+ /v1/models), rodando
 * cada requisição pelo claude-query.js (que spawna o CLI e bilha na ASSINATURA
 * Claude, não em API key). Serve pra plugar o Claude Code como "modelo" em
 * clientes OpenAI-compatíveis — ex.: o provider custom do hermes-webui.
 *
 * Montagem: require('./services/openai-compat').mount(app) no server.js.
 *
 * Auth: se OPENAI_COMPAT_KEY estiver setado no .env, exige Bearer igual. Sem a
 * var, aceita qualquer Authorization (o endpoint é local; o túnel expõe só o webui).
 *
 * Extensões OPT-IN (um cliente sem os cabeçalhos recebe exatamente o comportamento de sempre):
 *  - `X-Stream-Mode: live` com stream=true → SSE token a token (deltas, finish_reason, usage, [DONE]),
 *    com ": ping" a cada 15 s. Sem o cabeçalho, o stream continua sendo "texto inteiro num chunk só".
 *    OPENAI_COMPAT_LIVE_STREAM_DEFAULT=1 liga o modo ao vivo para todo stream=true.
 *  - `X-Conversation-Id` (+ `X-Conversation-Seen: N`) → retoma a sessão do Claude Code da conversa
 *    com --resume, mandando só as mensagens novas (as N primeiras do body já são conhecidas). Se não
 *    der pra retomar, cai no achatamento de sempre. Resposta leva `X-Session-Resumed: true|false`.
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../claude-query');
const authMonitor = require('./health/auth-monitor');
const { isAuthError } = authMonitor;
const sessionMap = require('./session-map');
const providers = require('./providers');
const { readClaudeStatus } = require('./account-status');

/** providers.json na raiz do backend: corrente de fallback (agente → grok-4) e provedores OpenAI-compatíveis. */
const PROVIDERS = providers.load(path.join(__dirname, '..', 'providers.json'), process.env, (m) => console.warn(`[openai-compat] ${m}`));
/** Próximo provedor openai disponível na corrente do modelo pedido (ou null). */
function _nextOpenai(reqModel) {
  for (const name of providers.chain(PROVIDERS, reqModel).slice(1)) {
    const p = providers.byName(PROVIDERS, name);
    if (p && p.type === 'openai' && p.available) return p;
  }
  return null;
}

const MODEL_ID = 'claudecode';

// cwd NEUTRO: rodar no diretório do backend faria o CLI carregar o CLAUDE.md de
// swarm (que o instrui a agir como agente de código e usar ferramentas). Um dir
// vazio dedicado evita esse auto-discovery e mantém comportamento de "chat".
const NEUTRAL_CWD = process.env.CLAUDECODE_CWD || path.join(os.tmpdir(), 'claudecode-shim-cwd');
try { fs.mkdirSync(NEUTRAL_CWD, { recursive: true }); } catch (_) {}

// Modelo AGÊNTICO "rene": roda o CLI dentro do workspace bridge-rene, que
// auto-descobre o CLAUDE.md e as skills. Sem diretiva de chat — pode usar
// ferramentas, então requests podem levar minutos.
const RENE_MODEL_ID = 'rene';
const RENE_CWD = process.env.RENE_CWD
  || path.join(__dirname, '..', 'bridge-rene');

// Modelo AGÊNTICO "rene-dm": igual ao "rene" (mesmo cwd/skills), mas com um
// MCP config restrito — usado nas conversas individuais (DM), sem acesso aos
// objetos financeiros do Twenty CRM nem a kiwi/abacatepay. A credencial do
// Twenty usada aqui (TWENTY_API_KEY_DM) precisa ter permissão reduzida no
// próprio CRM — o arquivo de MCP sozinho não é barreira de segurança real,
// só decide quais tools ficam visíveis.
const RENE_DM_MODEL_ID = 'rene-dm';
const RENE_DM_MCP_CONFIG = path.join(__dirname, '..', 'claude-mcp-servers-dm.json');

// Modelo AGÊNTICO "agente": Claude Code com ferramentas e bypassPermissions, mas FORA do
// bridge-rene (sem CLAUDE.md/skills do René, sem MCP dedicado): cwd próprio em
// ~/agent-workspace. É o "modo bypass" genérico usado pelo meu-bot; mesmo nome e
// comportamento do backend local (backend-colima/server.js).
const AGENTE_MODEL_ID = 'agente';
const AGENTE_CWD = process.env.AGENTE_CWD || path.join(os.homedir(), 'agent-workspace');
try { fs.mkdirSync(AGENTE_CWD, { recursive: true }); } catch (_) {}

// Perfis extras "rene-<perfil>" → claude-mcp-servers-<perfil>.json (ex.: rene-buffer
// pro bot Buffer do grokbot: MCP oficial do Buffer + Instagram/Notion + grok). Mesmo
// cwd/skills do rene; só troca o conjunto de MCPs. Sem arquivo → cai em chat puro,
// como qualquer model desconhecido.
function _profileMcpConfig(reqModel) {
  const m = /^rene-([a-z0-9-]+)$/.exec(reqModel);
  if (!m) return null;
  const p = path.join(__dirname, '..', `claude-mcp-servers-${m[1]}.json`);
  return require('fs').existsSync(p) ? p : null;
}

// Diretiva que transforma o Claude Code (agêntico) num assistente de chat direto.
const CHAT_DIRECTIVE =
  'Você é um assistente de chat. Responda direta e concisamente à conversa usando ' +
  'apenas seu próprio conhecimento. NÃO use ferramentas, NÃO explore arquivos, NÃO ' +
  'rode comandos e NÃO faça preâmbulos como "deixa eu verificar" — apenas responda.';

// Texto de uma mensagem OpenAI (string ou blocos {type:'text', text}).
function _messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

// Junta as mensagens do formato OpenAI num único prompt + system prompt.
// - mensagens 'system' → concatenadas em appendSystemPrompt
// - demais turnos → "Role: conteúdo" em ordem, pra dar contexto ao CLI
function _flattenMessages(messages) {
  const systemParts = [];
  const convoParts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m && m.role;
    const text = _messageText(m);
    if (!text) continue;
    if (role === 'system') {
      systemParts.push(text);
    } else if (role === 'assistant') {
      convoParts.push(`Assistant: ${text}`);
    } else {
      convoParts.push(`User: ${text}`);
    }
  }
  return {
    appendSystemPrompt: systemParts.join('\n\n'),
    prompt: convoParts.join('\n\n'),
  };
}

function _authOk(req) {
  const expected = process.env.OPENAI_COMPAT_KEY;
  if (!expected) return true; // sem chave configurada → libera (uso local)
  const hdr = req.headers['authorization'] || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  return token === expected;
}

// Claude Code deslogado às vezes devolve HTTP-sucesso com texto "Not logged in · Please run /login"
// — isso NÃO pode passar como resposta válida, senão o Hermes não cai no fallback.
function _looksLikeLoggedOut(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return false;
  return /not logged in/i.test(t)
    || /please run \/?login/i.test(t)
    || /^please run \/?login/i.test(t);
}

function _failAuth(res, message) {
  try { authMonitor.reportAuthFailure(message); } catch (_) {}
  return res.status(401).json({
    error: { message, type: 'authentication_error', code: 'claude_auth' },
  });
}

function _chunk(id, created, model, delta, finish_reason = null) {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

// Limite de turnos (RENE_MAX_TURNS): em vez de refazer do zero, retoma a MESMA sessão
// com --resume e pede a entrega do que já está pronto (arquivos como MEDIA:/caminho).
const WRAPUP_PROMPT = 'Você atingiu o limite de passos desta rodada. NÃO continue a tarefa nem rode mais ferramentas. '
  + 'Responda agora, em português: (1) o que já está pronto, incluindo cada arquivo gerado numa linha própria no formato MEDIA:/caminho/absoluto '
  + '(vídeo ou imagem) e (2) em uma frase, o que faltou fazer.';

/**
 * Roda a query no CLI com RETRY e entrega-após-limite, igual ao comportamento histórico.
 * O Claude Code (assinatura) às vezes sai com exit 1 SEM texto por rate-limit transitório —
 * repetir resolve (é o que o "regenerate" manual faz). Só falha de vez se todas as tentativas
 * vierem vazias. Se veio texto, um exit != 0 posterior (rate_limit_event/cleanup) é ignorado.
 *
 * `onEvent(m)` recebe cada mensagem do CLI (usado pelo streaming ao vivo); `canRetry()` permite
 * ao chamador vetar o retry depois que já emitiu conteúdo pro cliente.
 */
async function _collectResponse({ prompt, options, onEvent = null, canRetry = () => true }) {
  const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.CLAUDECODE_RETRIES || '3'));
  let text = '';
  let usage = null;
  let errored = null;
  let sessionId = null;
  let maxTurnsHit = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    text = ''; usage = null; errored = null; sessionId = null; maxTurnsHit = false;
    try {
      for await (const m of query({ prompt, options })) {
        if (onEvent) onEvent(m);
        if (m.type === 'system' && m.subtype === 'init' && m.session_id) sessionId = m.session_id;
        if (m.type === 'result') {
          if (m.subtype === 'error_max_turns') maxTurnsHit = true;
          if (m.is_error) errored = String(m.error || m.result || 'claude code error');
          else {
            if (typeof m.result === 'string') text = m.result;
            usage = m.usage || null;
          }
        } else if (m.type === 'assistant' && m.message?.content && !text) {
          text = m.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
        }
      }
    } catch (e) {
      errored = e.message || String(e);
    }
    if (maxTurnsHit && sessionId) {
      console.warn(`[openai-compat] limite de turnos (${options.maxTurns}) na sessão ${sessionId}; pedindo entrega do que já está pronto…`);
      let wrap = '';
      try {
        for await (const m of query({ prompt: WRAPUP_PROMPT, options: { ...options, resume: sessionId, maxTurns: 4 } })) {
          if (onEvent) onEvent(m, { wrapup: true });
          if (m.type === 'result' && !m.is_error && typeof m.result === 'string' && m.result) wrap = m.result;
          else if (m.type === 'assistant' && m.message?.content) {
            const t = m.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
            if (t) wrap = t;
          }
        }
      } catch (e) { console.warn(`[openai-compat] entrega após limite falhou: ${e.message || e}`); }
      if (wrap) { text = wrap; errored = null; }
    }
    if (text) break;                                       // sucesso → para
    if (attempt < MAX_ATTEMPTS && canRetry()) {
      console.warn(`[openai-compat] tentativa ${attempt}/${MAX_ATTEMPTS} falhou (${errored}); retry…`);
      await new Promise(r => setTimeout(r, 700 * attempt)); // backoff curto
    } else {
      break;
    }
  }

  if (text && _looksLikeLoggedOut(text)) {
    errored = text;
    text = '';
  }
  return { text, usage, errored, sessionId };
}

/** Erro de resume (sessão sumiu/inválida) antes de qualquer resposta: vale refazer sem --resume. */
function _looksLikeResumeFailure(errored) {
  return /no conversation found|session.*not found|could not resume|resume/i.test(String(errored || ''));
}

const CONV_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Decide entre retomar a sessão da conversa (prompt = só as mensagens novas) e achatar tudo.
 * `seen` = quantas mensagens não-system do body o servidor já conhece (cabeçalho do cliente).
 */
function _planPrompt({ messages, convId, seenHdr, key, options, sysHash }) {
  const flat = _flattenMessages(messages);
  const fallback = { prompt: flat.prompt, appendSystemPrompt: flat.appendSystemPrompt, resume: null };
  if (!convId) return fallback;
  const entry = sessionMap.get(key);
  if (!entry) return fallback;
  const sameProfile = entry.cwd === options.cwd && (entry.mcpConfigPath || null) === (options.mcpConfigPath || null) && entry.sysHash === sysHash;
  if (!sameProfile || !sessionMap.sessionFileExists(entry.cwd, entry.sessionId)) { sessionMap.del(key); return fallback; }
  const convo = (Array.isArray(messages) ? messages : []).filter(m => m && m.role !== 'system' && _messageText(m));
  const seen = Number.isInteger(seenHdr) ? seenHdr : entry.seen;
  if (!(seen > 0 && seen < convo.length)) return fallback;
  const fresh = convo.slice(seen);
  if (!fresh.some(m => m.role === 'user')) return fallback;
  const prompt = fresh.length === 1 ? _messageText(fresh[0]) : _flattenMessages(fresh).prompt;
  return { prompt, appendSystemPrompt: flat.appendSystemPrompt, resume: entry.sessionId };
}

function _usageChunk(id, created, model, usage) {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  return { id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
}

/**
 * Streaming AO VIVO: cabeçalhos SSE só quando o CLI começa a falar (erros antes continuam JSON com
 * status), deltas de texto token a token, ": ping" a cada 15 s, finish_reason + usage + [DONE].
 */
async function _streamLive(req, res, ctx) {
  const { id, created, respModel, options } = ctx;
  const abortController = new AbortController();
  const liveOptions = { ...options, includePartialMessages: true, abortController };
  let headersSent = false;
  let streamed = '';
  let sawDelta = false;
  let needsSep = false;
  let heartbeat = null;
  let finished = false;
  const t0 = Date.now();
  let firstDeltaAt = 0;

  const send = obj => { if (!finished) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const start = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Session-Resumed': ctx.resumed ? 'true' : 'false',
      ...(ctx.resumeSessionId ? { 'X-Claude-Session-Id': ctx.resumeSessionId } : {}),
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    send(_chunk(id, created, respModel, { role: 'assistant' }));
    heartbeat = setInterval(() => { if (!finished) res.write(': ping\n\n'); }, 15000);
  };
  const emitText = text => {
    if (!text) return;
    start();
    if (needsSep && streamed && !streamed.endsWith('\n')) { send(_chunk(id, created, respModel, { content: '\n\n' })); streamed += '\n\n'; }
    needsSep = false;
    if (!firstDeltaAt) firstDeltaAt = Date.now();
    streamed += text;
    send(_chunk(id, created, respModel, { content: text }));
  };
  const onEvent = (m) => {
    if (!m || m.type === 'system' || m.type === 'result') return;
    if (m.type === 'stream_event') {
      const ev = m.event || {};
      if (m.parent_tool_use_id) return; // texto de subagente não vai pro usuário
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { sawDelta = true; emitText(ev.delta.text); }
      else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'text' && streamed) needsSep = true;
      return;
    }
    if (m.type === 'assistant' && !sawDelta && m.message?.content) {
      // CLI sem --include-partial-messages: cada mensagem do assistente de uma vez.
      const t = m.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (t && streamed) needsSep = true;
      emitText(t);
    }
  };

  // Cliente desconectou antes do fim: 'close' em `res` (em `req`, no Node 16+, dispara quando o
  // corpo do pedido termina de chegar, o que abortaria todo stream logo no início).
  res.on('close', () => {
    if (!finished) {
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      try { abortController.abort(); } catch (_) {}
      console.warn(`[openai-compat] live ${id} abortado pelo cliente após ${Date.now() - t0} ms`);
    }
  });

  const result = await _collectResponse({ prompt: ctx.prompt, options: liveOptions, onEvent, canRetry: () => !streamed });
  if (finished) return result; // cliente foi embora

  if (!headersSent) {
    // Nada foi transmitido: com fallback possível, o chamador decide (outro provedor ou o erro).
    if (!result.text && result.errored && ctx.canFallback) return result;
    // Senão, erros viram JSON com status, como no modo legado.
    if (!result.text && result.errored && isAuthError(result.errored)) {
      authMonitor.reportAuthFailure(result.errored);
      res.status(401).json({ error: { message: result.errored, type: 'authentication_error', code: 'claude_auth' } });
      return result;
    }
    if (!result.text && result.errored) {
      res.status(503).json({ error: { message: result.errored, type: 'api_error' } });
      return result;
    }
    start();
  }
  if (!streamed && result.text) emitText(result.text); // só veio no "result"
  if (!streamed && !result.text && result.errored) {
    send(_chunk(id, created, respModel, { content: `\n[erro claudecode: ${result.errored}]` }, 'error'));
    send({ id, object: 'chat.completion.chunk', created, model: respModel, choices: [], error: { message: result.errored, type: 'api_error' } });
  } else {
    send(_chunk(id, created, respModel, {}, 'stop'));
    send(_usageChunk(id, created, respModel, result.usage));
  }
  res.write('data: [DONE]\n\n');
  finished = true;
  if (heartbeat) clearInterval(heartbeat);
  res.end();
  console.log(`[openai-compat] live id=${id} model=${respModel} first_delta_ms=${firstDeltaAt ? firstDeltaAt - t0 : -1} total_ms=${Date.now() - t0} chars=${streamed.length} resumed=${ctx.resumed}`);
  return result;
}

/**
 * Atende um provedor OpenAI-compatível (xAI pelo hermes proxy, ou direto com chave): usado quando o
 * cliente pede o modelo (ex.: "grok-4") ou como fallback depois que o Claude falhou sem produzir texto.
 * `note` = {from, to, reason} quando é fallback; vai num chunk `x_meu_bot.fallback` para o cliente avisar.
 */
async function _serveOpenai(req, res, { provider, messages, stream, live, id, created, note = null }) {
  const abort = new AbortController();
  let headersSent = false; let heartbeat = null; let finished = false; let streamed = '';
  const t0 = Date.now();
  res.on('close', () => { if (!finished) { finished = true; if (heartbeat) clearInterval(heartbeat); try { abort.abort(); } catch (_) {} } });
  const send = (obj) => { if (!finished) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const start = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Session-Resumed': 'false', 'X-Provider': provider.name });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    send(_chunk(id, created, provider.name, { role: 'assistant' }));
    if (note) send(providers.fallbackChunk(id, created, provider.name, note.from, note.to, note.reason));
    heartbeat = setInterval(() => { if (!finished) res.write(': ping\n\n'); }, 15000);
  };
  const onDelta = live ? (t) => { start(); streamed += t; send(_chunk(id, created, provider.name, { content: t })); } : null;
  let out;
  try {
    out = await providers.openaiCompletion({ provider, messages, signal: abort.signal, onDelta });
  } catch (e) {
    if (finished) return;
    console.warn(`[openai-compat] ${provider.name}${note ? ` (fallback de ${note.from})` : ''} falhou: ${e.code || '?'} ${e.message}`);
    if (headersSent) {
      send(_chunk(id, created, provider.name, { content: `\n[erro ${provider.name}: ${e.message}]` }, 'error'));
      send({ id, object: 'chat.completion.chunk', created, model: provider.name, choices: [], error: { message: e.message, type: 'api_error' } });
      res.write('data: [DONE]\n\n'); finished = true; if (heartbeat) clearInterval(heartbeat); return res.end();
    }
    const msg = note ? `${note.from}: ${note.reason} | ${provider.name}: ${e.message}` : e.message;
    return res.status(e.code === 'upstream_401' ? 401 : 503).json({ error: { message: msg, type: 'api_error', code: e.code || 'upstream_failed' } });
  }
  if (finished) return;
  console.log(`[openai-compat] ${provider.name}${note ? ` (fallback de ${note.from})` : ''} ${live ? 'live' : stream ? 'stream' : 'json'} total_ms=${Date.now() - t0} chars=${out.text.length}`);
  if (live || stream) {
    start();
    if (!streamed) send(_chunk(id, created, provider.name, { content: out.text }));
    send(_chunk(id, created, provider.name, {}, 'stop'));
    send(_usageChunk(id, created, provider.name, out.usage));
    res.write('data: [DONE]\n\n'); finished = true; if (heartbeat) clearInterval(heartbeat); return res.end();
  }
  res.setHeader('X-Session-Resumed', 'false'); res.setHeader('X-Provider', provider.name);
  return res.json({
    id, object: 'chat.completion', created, model: provider.name,
    choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: out.usage?.input_tokens ?? 0, completion_tokens: out.usage?.output_tokens ?? 0, total_tokens: (out.usage?.input_tokens ?? 0) + (out.usage?.output_tokens ?? 0) },
    ...(note ? { x_meu_bot: { fallback: note } } : {}),
  });
}

function mount(app) {
  const jsonBig = express.json({ limit: '25mb' });

  // Lista de modelos — alguns clientes chamam isto antes de usar.
  app.get('/v1/models', (req, res) => {
    if (!_authOk(req)) return res.status(401).json({ error: { message: 'invalid api key', type: 'invalid_request_error' } });
    res.json({
      object: 'list',
      data: [
        { id: MODEL_ID, object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
        { id: RENE_MODEL_ID, object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
        { id: RENE_DM_MODEL_ID, object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
        { id: AGENTE_MODEL_ID, object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
        { id: 'rene-buffer', object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
        ...providers.openaiModels(PROVIDERS).map((p) => ({ id: p.name, object: 'model', created: 0, owned_by: p.base_url, description: p.description })),
      ],
    });
  });

  // Status line do meu-bot: conta e limites do Claude Code desta máquina (cache do statusline.sh).
  app.get('/v1/meu-bot/status', (req, res) => {
    if (!_authOk(req)) return res.status(401).json({ error: { message: 'invalid api key', type: 'invalid_request_error' } });
    res.json({ claude: readClaudeStatus(), providers: PROVIDERS.map((p) => ({ name: p.name, type: p.type, available: p.available })) });
  });

  app.post('/v1/chat/completions', jsonBig, async (req, res) => {
    if (!_authOk(req)) return res.status(401).json({ error: { message: 'invalid api key', type: 'invalid_request_error' } });

    // Modelo de um provedor OpenAI-compatível (ex.: "grok-4"): atende direto, sem Claude, mesmo em authDown.
    {
      const direct = providers.byName(PROVIDERS, String((req.body || {}).model || '').toLowerCase());
      if (direct && direct.type === 'openai') {
        if (!direct.available) return res.status(404).json({ error: { message: `provedor ${direct.name} sem chave/endpoint nesta máquina`, type: 'invalid_request_error', code: 'model_not_found' } });
        const b = req.body || {};
        const live0 = b.stream === true && (String(req.headers['x-stream-mode'] || '').toLowerCase() === 'live' || process.env.OPENAI_COMPAT_LIVE_STREAM_DEFAULT === '1');
        return _serveOpenai(req, res, { provider: direct, messages: b.messages, stream: b.stream === true, live: live0, id: `chatcmpl-${uuidv4()}`, created: Math.floor(Date.now() / 1000) });
      }
    }

    // authDown: falha o primary de verdade pra o Hermes cair no fallback_providers (xAI).
    // Não usar SSE 200 com texto de erro — isso NÃO dispara fallback.
    // Exceção: modelo com reserva na corrente (agente → grok-4) cai para ela em vez de 503.
    if (authMonitor.isDown()) {
      const b0 = req.body || {};
      const reqModel0 = String(b0.model || '').toLowerCase();
      const fb0 = _nextOpenai(reqModel0);
      if (fb0 && Array.isArray(b0.messages)) {
        const live0 = b0.stream === true && (String(req.headers['x-stream-mode'] || '').toLowerCase() === 'live' || process.env.OPENAI_COMPAT_LIVE_STREAM_DEFAULT === '1');
        console.warn(`[openai-compat] authDown: ${reqModel0} → ${fb0.name}`);
        return _serveOpenai(req, res, { provider: fb0, messages: b0.messages, stream: b0.stream === true, live: live0, id: `chatcmpl-${uuidv4()}`, created: Math.floor(Date.now() / 1000), note: { from: reqModel0, to: fb0.name, reason: 'Claude Code deslogado nesta máquina (authDown)' } });
      }
      return res.status(503).json({
        error: {
          message: 'claude authDown — primary unavailable; client should use fallback',
          type: 'api_error',
          code: 'claude_auth_down',
        },
      });
    }

    const body = req.body || {};
    const stream = body.stream === true;
    const live = stream && (String(req.headers['x-stream-mode'] || '').toLowerCase() === 'live' || process.env.OPENAI_COMPAT_LIVE_STREAM_DEFAULT === '1');
    const convIdRaw = String(req.headers['x-conversation-id'] || '');
    const convId = CONV_ID_RE.test(convIdRaw) ? convIdRaw : null;
    const seenRaw = parseInt(String(req.headers['x-conversation-seen'] || ''), 10);
    const seenHdr = Number.isInteger(seenRaw) && seenRaw >= 0 ? seenRaw : null;

    const { appendSystemPrompt, prompt: flatPrompt } = _flattenMessages(body.messages);
    if (!flatPrompt) {
      return res.status(400).json({ error: { message: 'messages: pelo menos uma mensagem user/assistant com conteúdo', type: 'invalid_request_error' } });
    }

    const id = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);

    // Modelo de um provedor OpenAI-compatível (ex.: "grok-4"): atende direto, sem Claude.
    const direct = providers.byName(PROVIDERS, String(body.model || '').toLowerCase());
    if (direct && direct.type === 'openai') {
      if (!direct.available) return res.status(404).json({ error: { message: `provedor ${direct.name} sem chave/endpoint nesta máquina`, type: 'invalid_request_error', code: 'model_not_found' } });
      return _serveOpenai(req, res, { provider: direct, messages: body.messages, stream, live, id, created });
    }

    // model=rene → agêntico, MCP completo. model=rene-dm → agêntico, MCP
    // restrito (sem financeiro). Qualquer outro valor → chat puro.
    const reqModel = String(body.model || '').toLowerCase();
    const agenticFull = reqModel === RENE_MODEL_ID;
    const agenticDm = reqModel === RENE_DM_MODEL_ID;
    const agenticPlain = reqModel === AGENTE_MODEL_ID;
    const profileMcp = (!agenticFull && !agenticDm && !agenticPlain) ? _profileMcpConfig(reqModel) : null;
    const agentic = agenticFull || agenticDm || agenticPlain || !!profileMcp;
    const respModel = agentic ? reqModel : MODEL_ID;

    // Chat: cwd neutro + diretiva → responde direto sem virar agente de código
    // (maxTurns com folga é só rede de segurança; a diretiva deve manter 1 turno).
    // Agêntico (rene/rene-dm): cwd no bridge-rene, sem diretiva, maxTurns maior
    // pra dar conta de skills. rene-dm troca só o mcpConfigPath.
    const options = {
      maxTurns: agentic
        ? parseInt(process.env.RENE_MAX_TURNS || '30')
        : parseInt(process.env.CLAUDECODE_MAX_TURNS || '8'),
      permissionMode: 'bypassPermissions',
      includePartialMessages: false,
      cwd: agenticPlain ? AGENTE_CWD : agentic ? RENE_CWD : NEUTRAL_CWD,
      appendSystemPrompt: agentic
        ? appendSystemPrompt
        : [CHAT_DIRECTIVE, appendSystemPrompt].filter(Boolean).join('\n\n'),
      ...(agenticDm ? { mcpConfigPath: RENE_DM_MCP_CONFIG } : profileMcp ? { mcpConfigPath: profileMcp } : {}),
    };

    // Retomada de sessão (opt-in): chave inclui o modelo; perfil (cwd/mcp/system) precisa bater.
    const sysHash = crypto.createHash('sha1').update(`${respModel}\n${options.appendSystemPrompt}`).digest('hex');
    const key = convId ? `${respModel}:${convId}` : null;
    const plan = _planPrompt({ messages: body.messages, convId, seenHdr, key, options, sysHash });
    let prompt = plan.prompt;
    let resumeSessionId = plan.resume;

    // DEBUG (CLAUDECODE_DEBUG=1): dump do prompt/options pra diagnosticar exit 1.
    if (process.env.CLAUDECODE_DEBUG === '1') {
      try {
        require('fs').writeFileSync('/tmp/cc-lastreq.json', JSON.stringify({
          promptLen: prompt.length, sysLen: options.appendSystemPrompt.length,
          prompt, appendSystemPrompt: options.appendSystemPrompt, stream, live, convId, resume: resumeSessionId,
        }));
      } catch (_) {}
    }

    const run = async () => {
      const runOptions = resumeSessionId ? { ...options, resume: resumeSessionId } : options;
      const ctx = { id, created, respModel, prompt, options: runOptions, resumed: !!resumeSessionId, resumeSessionId, canFallback: !!_nextOpenai(reqModel) };
      let result;
      if (live) result = await _streamLive(req, res, ctx);
      else result = await _collectResponse({ prompt, options: runOptions });

      // Resume falhou antes de qualquer resposta (sessão sumiu): refaz uma vez achatando tudo.
      if (resumeSessionId && !result.text && result.errored && _looksLikeResumeFailure(result.errored) && !res.headersSent) {
        console.warn(`[openai-compat] resume da sessão ${resumeSessionId} falhou (${result.errored}); refazendo sem --resume`);
        sessionMap.del(key);
        resumeSessionId = null;
        prompt = flatPrompt;
        const ctx2 = { id, created, respModel, prompt, options, resumed: false, resumeSessionId: null, canFallback: !!_nextOpenai(reqModel) };
        result = live ? await _streamLive(req, res, ctx2) : await _collectResponse({ prompt, options });
      }

      // Guarda a sessão desta conversa para o próximo turno.
      if (key && result.sessionId && result.text) {
        const convoCount = (Array.isArray(body.messages) ? body.messages : []).filter(m => m && m.role !== 'system' && _messageText(m)).length;
        sessionMap.put(key, { sessionId: result.sessionId, cwd: options.cwd, mcpConfigPath: options.mcpConfigPath || null, sysHash, seen: convoCount + 1 });
      } else if (key && result.errored && !result.text) {
        sessionMap.del(key);
      }
      return result;
    };

    const { text, usage, errored } = key ? await sessionMap.withLock(key, run) : await run();

    // Claude falhou sem produzir nada e há outro provedor na corrente: desce para ele e avisa o cliente.
    const fallbackTo = (!text && errored) ? _nextOpenai(reqModel) : null;
    if (fallbackTo && !res.headersSent) {
      console.warn(`[openai-compat] ${reqModel} falhou (${String(errored).slice(0, 200)}); caindo para ${fallbackTo.name}`);
      if (isAuthError(errored)) authMonitor.reportAuthFailure(errored);
      return _serveOpenai(req, res, { provider: fallbackTo, messages: body.messages, stream, live, id, created, note: { from: reqModel, to: fallbackTo.name, reason: String(errored).slice(0, 300) } });
    }
    if (live) {
      if (res.headersSent) return; // _streamLive já respondeu
      // canFallback adiou o erro, mas não há para onde cair: responde como o modo legado.
      if (isAuthError(errored)) { authMonitor.reportAuthFailure(errored); return res.status(401).json({ error: { message: errored, type: 'authentication_error', code: 'claude_auth' } }); }
      return res.status(503).json({ error: { message: errored || 'sem resposta', type: 'api_error' } });
    }

    if (convId) res.setHeader('X-Session-Resumed', resumeSessionId ? 'true' : 'false');

    // ── Streaming (SSE legado): entrega o texto coletado (robusto; não token-a-token) ──
    if (stream) {
      if (!text && errored && isAuthError(errored)) {
        authMonitor.reportAuthFailure(errored);
        return res.status(401).json({ error: { message: errored, type: 'authentication_error', code: 'claude_auth' } });
      }
      if (!text && errored) {
        return res.status(503).json({ error: { message: errored, type: 'api_error' } });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send(_chunk(id, created, respModel, { role: 'assistant' }));
      if (text) {
        send(_chunk(id, created, respModel, { content: text }));
        send(_chunk(id, created, respModel, {}, 'stop'));
      } else {
        send(_chunk(id, created, respModel, { content: `\n[erro claudecode: ${errored || 'sem resposta'}]` }, 'stop'));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ── Não-streaming ──
    if (!text && errored) {
      if (isAuthError(errored)) {
        authMonitor.reportAuthFailure(errored);
        return res.status(401).json({ error: { message: errored, type: 'authentication_error', code: 'claude_auth' } });
      }
      return res.status(503).json({ error: { message: errored, type: 'api_error' } });
    }

    res.json({
      id, object: 'chat.completion', created, model: respModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: usage?.input_tokens ?? 0,
        completion_tokens: usage?.output_tokens ?? 0,
        total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      },
    });
  });
}

module.exports = { mount, MODEL_ID, _flattenMessages, _planPrompt, _collectResponse };
