'use strict';
// anti-loop.js — freios contra loops agente↔agente e spam de resposta:
// cooldown de turnos por grupo, freio bot↔bot em DM/grupo, lista de bots
// conhecidos e dedup semântico de respostas.

// ── Anti-loop para grupos agente-agente ──
// Controla cooldown por grupo: máximo MAX_GROUP_TURNS respostas dentro de
// GROUP_COOLDOWN_MS. Após atingir o limite, silencia até o cooldown expirar.
const MAX_GROUP_TURNS = 3;           // premissa maior, menor, síntese — depois para
const GROUP_COOLDOWN_MS = 5 * 60000; // 5 minutos de silêncio após 3 turnos

// ── Bots conhecidos em grupos — NUNCA responder a mensagens deles ──
// Adicionar JIDs de outros agentes/bots pra evitar loop agente-agente.
const KNOWN_BOT_JIDS = new Set([
  // Lucrecia (OpenClaw) — JID pode variar; usar prefixo do número
  // Adicionar aqui conforme novos bots entrarem nos grupos
]);
// Prefixos de números de bots (parte antes do @s.whatsapp.net)
// Bots conhecidos por prefixo de LID — anti-loop bot↔bot.
// IMPORTANTE: estes LIDs podem RESOLVER pra números de pessoas reais via
// Baileys (o device de uma pessoa pode hospedar um bot). Bloquear aqui é
// separado de identificar a pessoa: o resolver pode dizer o nome dela, mas se
// o LID está nesta lista, _isFromKnownBot retorna true e a mensagem é
// ignorada como bot.
// Config via env WHATSAPP_KNOWN_BOT_PREFIXES (CSV). O _jidIsKnownBot faz match
// literal e NÃO resolve LID↔número, então um DM que chega como número (e não
// LID) escaparia do anti-loop bot↔bot — listar AMBAS as formas (LID e número)
// de cada device garante o freio em qualquer caso.
const KNOWN_BOT_PREFIXES = (process.env.WHATSAPP_KNOWN_BOT_PREFIXES || '')
  .split(',')
  .map((s) => s.trim().replace(/^\+/, ''))
  .filter(Boolean);
const _groupTurnTracker = new Map(); // groupJid → { turns: number, windowStart: number }

function _checkGroupAntiLoop(groupJid) {
  const now = Date.now();
  let tracker = _groupTurnTracker.get(groupJid);

  if (!tracker || (now - tracker.windowStart) > GROUP_COOLDOWN_MS) {
    // Janela expirou ou primeiro uso — reseta
    tracker = { turns: 0, windowStart: now };
    _groupTurnTracker.set(groupJid, tracker);
  }

  if (tracker.turns >= MAX_GROUP_TURNS) {
    const remainMs = GROUP_COOLDOWN_MS - (now - tracker.windowStart);
    if (remainMs > 0) {
      console.log(`🛑 Anti-loop: grupo ${groupJid} em cooldown (${Math.ceil(remainMs / 1000)}s restantes)`);
      return false; // bloqueado
    }
    // Cooldown expirou — reseta
    tracker.turns = 0;
    tracker.windowStart = now;
  }

  tracker.turns++;
  return true; // permitido
}

// ── Anti-loop para DM agente-agente (bot↔bot) ──
// No DM não existe o bloqueio _isFromKnownBot (ele só roda no caminho de grupo),
// então a conversa René↔outro-agente por DM precisa de um freio próprio: ela
// pode INICIAR e trocar algumas mensagens, mas FECHA após MAX_DM_BOT_TURNS pra
// não loopar infinito. A janela reseta após DM_BOT_COOLDOWN_MS de silêncio,
// permitindo reengajar mais tarde. Este é o único freio DURO no DM (o resto é
// comportamental, via SOUL.md).
const MAX_DM_BOT_TURNS = 6;            // ~3 idas e voltas, depois silencia
const DM_BOT_COOLDOWN_MS = 5 * 60000;  // 5 min de silêncio após o limite
const _dmBotTurnTracker = new Map();   // jid → { turns, windowStart }

function _jidIsKnownBot(jid) {
  const id = String(jid || '').split('@')[0].split(':')[0];
  return KNOWN_BOT_PREFIXES.includes(id);
}

function _checkDmBotAntiLoop(jid) {
  const now = Date.now();
  let tracker = _dmBotTurnTracker.get(jid);
  if (!tracker || (now - tracker.windowStart) > DM_BOT_COOLDOWN_MS) {
    tracker = { turns: 0, windowStart: now };
    _dmBotTurnTracker.set(jid, tracker);
  }
  if (tracker.turns >= MAX_DM_BOT_TURNS) {
    const remainMs = DM_BOT_COOLDOWN_MS - (now - tracker.windowStart);
    if (remainMs > 0) {
      console.log(`🛑 Anti-loop DM bot↔bot: ${jid} em cooldown (${Math.ceil(remainMs / 1000)}s restantes)`);
      return false; // bloqueado — fecha a conversa
    }
    tracker.turns = 0;
    tracker.windowStart = now;
  }
  tracker.turns++;
  return true; // permitido
}

// Checa se o remetente é um bot conhecido (evita loop agente-agente).
function _isFromKnownBot(msg) {
  const participant = msg.key.participant || '';
  const participantNumber = participant.split('@')[0]?.split(':')[0];
  if (KNOWN_BOT_JIDS.has(participant)) return true;
  if (participantNumber && KNOWN_BOT_PREFIXES.some(p => participantNumber === p)) return true;
  return false;
}

// ── Dedup semântico de respostas ──
const _lastReplyByJid = new Map();   // remoteJid → { norm, ts } — dedup semântico anti-loop
const SEMANTIC_DEDUP_WINDOW_MS = 60_000;

// Normalização leve pra dedup: lowercase, sem pontuação/whitespace, cap em 200 chars.
// Pega "Registrado." === "Registrado" === "registrado!", mas não confunde respostas
// genuinamente diferentes.
function _normForDedup(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s.,!?;:\-—…()\[\]"'`]/g, '')
    .slice(0, 200);
}

module.exports = {
  _checkGroupAntiLoop,
  _checkDmBotAntiLoop,
  _jidIsKnownBot,
  _isFromKnownBot,
  _normForDedup,
  _lastReplyByJid,
  SEMANTIC_DEDUP_WINDOW_MS,
};
