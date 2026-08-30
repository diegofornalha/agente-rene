// Histórico de conversas por canal (multi-turno).
// Chave = platform:jid (ex: wa:5511999999999@s.whatsapp, tg:123456789).
// Mantém últimos N turnos por sessão.
//
// Source of truth = Map em memória (este módulo). Writes são espelhados pro
// session-store SQLite quando SESSION_STORE_BACKEND=sqlite (no-op em memory).
// No boot do módulo, rehydramos sessões das últimas 2h pra preservar contexto
// através de restart do PM2.
//
// blueprint: hermes-agent/gateway/session_context.py — SessionContextManager

const sessionStore = require('./session-store');
const logger = require('../logger');

const MAX_TURNS = 6;          // últimas 6 interações (user + assistant = 1 turno)
const REHYDRATE_TTL_MS = 2 * 60 * 60 * 1000; // 2h — alinhado com sessionContext
const KNOWN_PLATFORMS = ['wa', 'tg'];

const _store = new Map(); // sessionKey → { turns: [], lastActivity: ts }

// ── Helpers ────────────────────────────────────────────────────────────────

function _key(platform, jid) {
  return `${platform}:${jid}`;
}

function _scope(platform) {
  return `history:${platform}`;
}

// Reconstrói turns pareados a partir das mensagens planas vindas do SQLite.
function _msgsToTurns(messages) {
  const turns = [];
  let current = null;
  for (const m of messages) {
    if (m.role === 'user') {
      if (current) turns.push(current);
      current = { user: m.content, assistant: null, at: m.timestamp };
    } else if (m.role === 'assistant') {
      if (current) {
        current.assistant = m.content;
        turns.push(current);
        current = null;
      } else {
        // assistant órfão — mantém pra não perder dado
        turns.push({ user: '', assistant: m.content, at: m.timestamp });
      }
    }
  }
  if (current) turns.push(current);
  return turns;
}

let _bootstrapped = false;
function _bootstrap() {
  if (_bootstrapped) return;
  // Race-safe: writer Map is mutated before the flag flips, so concurrent
  // addTurn/getHistory calls during rehydrate either see empty _store (no
  // history yet) or post-rehydrate state — but never partial reads.
  let totalRestored = 0;
  for (const platform of KNOWN_PLATFORMS) {
    try {
      const rehydrated = sessionStore.rehydrate({ scope: _scope(platform), maxAgeMs: REHYDRATE_TTL_MS });
      for (const [jid, data] of rehydrated.entries()) {
        const turns = _msgsToTurns(data.messages);
        if (turns.length > 0) {
          _store.set(_key(platform, jid), { turns, lastActivity: data.lastActivity });
          totalRestored++;
        }
      }
    } catch (e) {
      logger.error({ err: e, platform }, `conv-history rehydrate ${platform} failed`);
    }
  }
  _bootstrapped = true;
  if (totalRestored > 0) {
    logger.info(`📦 [CONV] Rehydrated ${totalRestored} sessions (backend=${sessionStore.BACKEND})`);
  }
}

// ── API pública ─────────────────────────────────────────────────────────────

// Adiciona um turno (user msg + optional assistant reply) à sessão.
function addTurn(platform, jid, userMsg, assistantMsg = null) {
  _bootstrap();
  const k = _key(platform, jid);
  if (!_store.has(k)) {
    _store.set(k, { turns: [], lastActivity: Date.now() });
  }
  const session = _store.get(k);
  const now = Date.now();
  session.turns.push({
    user: userMsg,
    assistant: assistantMsg,
    at: now,
  });
  // Mantém só os últimos MAX_TURNS
  if (session.turns.length > MAX_TURNS) {
    session.turns = session.turns.slice(-MAX_TURNS);
  }
  session.lastActivity = now;

  // Mirror pro SQLite: user e assistant viram linhas separadas mas inseridas atomicamente.
  const messages = [];
  if (userMsg) messages.push({ role: 'user', content: userMsg, timestamp: now });
  if (assistantMsg) messages.push({ role: 'assistant', content: assistantMsg, timestamp: now });
  if (messages.length > 0) {
    sessionStore.persistMessages({
      scope: _scope(platform),
      sessionId: jid,
      messages,
      createdAt: session.turns[0]?.at || now,
      maxKeep: MAX_TURNS * 2,
    });
  }
}

// Retorna array de { role, content } prontos pra concatenar no prompt.
// Formato: alterna user/assistant (até 12 entries = 6 turnos).
function getHistory(platform, jid) {
  _bootstrap();
  const session = _store.get(_key(platform, jid));
  if (!session) return [];

  const out = [];
  for (const turn of session.turns) {
    if (turn.user) out.push({ role: 'user', content: turn.user });
    if (turn.assistant) out.push({ role: 'assistant', content: turn.assistant });
  }
  return out;
}

// Retorna string formatada pra injetar no prompt.
// Include last N turns (default 4 = ~800 tokens de contexto).
function getFormattedHistory(platform, jid, lastN = 4) {
  _bootstrap();
  const history = getHistory(platform, jid);
  const recent = history.slice(-lastN * 2); // lastN turnos = 2 entries por turno
  if (recent.length === 0) return '';

  const lines = ['\n### Contexto da conversa anterior (últimas mensagens):\n'];
  for (const msg of recent) {
    const label = msg.role === 'user' ? 'Usuário' : 'Assistente';
    // Trunca msgs longas (>400 chars) pra não inchar o prompt
    const content = msg.content.length > 400
      ? msg.content.slice(0, 400) + '…'
      : msg.content;
    lines.push(`[${label}]: ${content}`);
  }
  return lines.join('\n') + '\n\n---\n\n';
}

// Limpa sessão (se o user pedir "esquece conversa").
function clearSession(platform, jid) {
  _store.delete(_key(platform, jid));
  sessionStore.purge({ scope: _scope(platform), sessionId: jid });
}

// Estatísticas pra debug/metrics.
function stats() {
  let total = 0;
  for (const s of _store.values()) total += s.turns.length;
  return { sessions: _store.size, total_turns: total, backend: sessionStore.BACKEND };
}

module.exports = { addTurn, getHistory, getFormattedHistory, clearSession, stats };
