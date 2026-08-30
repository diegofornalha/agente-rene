'use strict';
// reply-delivery.js — estado e helpers da entrega de respostas do canal:
// mapas de tasks pendentes/fila por jid, avisos de authDown/up, formatação da
// resposta final, rehidratação de tasks zombie e resumo de progresso
// (heartbeat) em linguagem natural.

const authMonitor = require('../health/auth-monitor');
const { isAuthErrorStrict } = authMonitor;
const sockRef = require('./sock-ref');
const { _appendConv, _jidToRole } = require('./conv-log');
const { _stripLinkFormatting } = require('./message-extract');
const { TTS_ENABLED, TTS_MODE, _sendAsAudio } = require('./tts');
const L = require('../../config/locale');

const pendingByTaskId = new Map();   // taskId → { remoteJid, startedAt }
const inflightByJid   = new Map();   // remoteJid → Promise (preserva ordem por user)

// ── AuthDown: lembrete amigável quando o plano Claude desconecta ──
// Rate-limit por chat: grupo ativo com 20 mensagens não pode virar 20 lembretes
// (recriaria o problema original de spam de erro).
const _authNoticeByJid = new Map();  // remoteJid → lastNotifiedAt
const AUTH_NOTICE_COOLDOWN_MS = 5 * 60_000;
const AUTH_DOWN_NOTICE = '⚠️ Tô temporariamente fora do ar: minha sessão do Claude desconectou aqui no servidor. Preciso que reconectem o login do Claude pra eu voltar a responder. Assim que voltar, eu aviso por aqui. 🙏';
const AUTH_UP_NOTICE = '✅ Pronto, reconectei! Já tô de volta ao normal. Pode mandar de novo o que precisava que agora eu respondo.';

// Envia o lembrete de authDown respeitando o cooldown por chat.
async function _notifyAuthDown(remoteJid) {
  const now = Date.now();
  const last = _authNoticeByJid.get(remoteJid) || 0;
  if (now - last < AUTH_NOTICE_COOLDOWN_MS) {
    console.log(`🔐 authDown: lembrete pro ${remoteJid} suprimido (enviado há ${Math.round((now - last) / 1000)}s)`);
    return;
  }
  _authNoticeByJid.set(remoteJid, now);
  authMonitor.markNotified(remoteJid);
  try {
    if (TTS_MODE === 'audio_only' && TTS_ENABLED) {
      await _sendAsAudio(remoteJid, AUTH_DOWN_NOTICE);
    } else {
      await sock.sendMessage(remoteJid, { text: AUTH_DOWN_NOTICE });
    }
    _appendConv(`bot→${_jidToRole(remoteJid)}`, AUTH_DOWN_NOTICE);
    console.log(`🔐 authDown: lembrete enviado pro ${remoteJid}`);
  } catch (e) {
    console.warn(`⚠️ authDown: falha ao enviar lembrete: ${e.message}`);
  }
}

// Login voltou: anuncia a recuperação nos chats que receberam o aviso de
// queda. Listener registrado no módulo (roda 1x no require) — dentro de
// start() duplicaria a cada reconnect do Baileys.
authMonitor.on('up', async ({ notifiedJids = [] } = {}) => {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) {
    console.log('🔐 auth up — WhatsApp desconectado, sem anúncio de recuperação');
    return;
  }
  for (const jid of notifiedJids) {
    try {
      if (TTS_MODE === 'audio_only' && TTS_ENABLED) {
        await _sendAsAudio(jid, AUTH_UP_NOTICE);
      } else {
        await sock.sendMessage(jid, { text: AUTH_UP_NOTICE });
      }
      _appendConv(`bot→${_jidToRole(jid)}`, AUTH_UP_NOTICE);
      console.log(`🔐 auth up: recuperação anunciada pro ${jid}`);
    } catch (e) {
      console.warn(`⚠️ auth up: falha ao anunciar pro ${jid}: ${e.message}`);
    }
  }
  authMonitor.clearNotified();
  _authNoticeByJid.clear();
});

function _formatReply(task) {
  if (task.status === 'done') {
    const r = task.result?.trim();
    // Defensivo: 401 do plano NUNCA sai cru. O task-runner intercepta na
    // origem; isto cobre zombie tasks antigas rehidratadas de antes do fix.
    if (isAuthErrorStrict(r)) {
      authMonitor.reportAuthFailure(r);
      return AUTH_DOWN_NOTICE;
    }
    return r ? _stripLinkFormatting(r) : '(resposta vazia)';
  }
  if (task.status === 'cancelled') {
    return '⏹️ Cancelado.';
  }
  // Erro: NUNCA expor detalhes técnicos nem pedir pra reenviar/tentar de novo.
  return '🤔 Hmm, deu um problema aqui do meu lado. Já tô vendo o que aconteceu.';
}

// Rehidrata ctx do canal pra tasks WhatsApp que sobreviveram a restart do backend.
// Sem isso, zombie tasks resumidas pelo task-runner rodam sem heartbeat E sem
// entrega final — porque pendingByTaskId é in-memory. Casa `task.tags` com o
// padrão `from:${remoteJid}` setado em createTask (linha 1185).
function _rehydrateZombieTasks(taskRunner) {
  if (!taskRunner || typeof taskRunner.listTasks !== 'function') return;
  const candidates = [
    ...taskRunner.listTasks({ source: 'whatsapp', status: 'running', limit: 100 }),
    ...taskRunner.listTasks({ source: 'whatsapp', status: 'queued',  limit: 100 }),
  ];
  let count = 0;
  for (const task of candidates) {
    if (pendingByTaskId.has(task.id)) continue;
    const fromTag = (task.tags || []).find(t => typeof t === 'string' && t.startsWith('from:'));
    if (!fromTag) continue;
    const remoteJid = fromTag.slice('from:'.length);
    if (!remoteJid) continue;
    pendingByTaskId.set(task.id, {
      remoteJid,
      startedAt: task.startedAt || task.createdAt || Date.now(),
      _rehydrated: true,
    });
    count++;
    console.log(`🩺 Rehidratado ctx zombie: task ${task.id.slice(0,8)} (${task.status}) → ${remoteJid}`);
  }
  if (count > 0) console.log(`🩺 ${count} task(s) WhatsApp adotada(s) — heartbeat + entrega ativos.`);
}

// Resume os steps recentes (1 frase PT-BR natural, 1ª pessoa) de forma
// determinística — sem LLM. O backend não tem ANTHROPIC_API_KEY direta (usa
// OAuth via Claude Code SDK), então chamar Haiku via fetch falha; e gastar
// uma sessão do SDK pra cada heartbeat (a cada 20s) consumiria slots da pool
// principal. Categoriza por tipo de tool e gera frase variada com base no
// que rolou + o que está rolando agora.
//
// Quando NÃO há tools no delta (raciocínio puro, comum nos primeiros segundos
// e no grupo do LinkedIn onde a primeira fase é pensar a estratégia), usa o
// texto do step assistant como base do resumo — é o próprio raciocínio do
// agente, já em PT-BR/1ª pessoa.
function _summarizeStepsViaClaude(newSteps) {
  if (!Array.isArray(newSteps) || newSteps.length === 0) return null;
  const withTool = newSteps.filter(s => s.toolName);

  // ── Fallback A: usa o raciocínio do agente quando não há tool no delta ──
  if (withTool.length === 0) {
    const lastThought = _extractLastThought(newSteps);
    if (lastThought) return lastThought;
    // Fallback concreto: descreve o que existe no delta em vez de frase vaga
    const assistantCount = newSteps.filter(s => s?.type === 'assistant').length;
    return assistantCount > 0
      ? L.steps.analyzing(assistantCount)
      : L.steps.processing(newSteps.length);
  }

  const cats = {
    read:  ['Read', 'Glob', 'Grep'],
    web:   ['WebFetch', 'WebSearch'],
    edit:  ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
    bash:  ['Bash'],
    task:  ['Task'],
    todo:  ['TodoWrite'],
  };
  const cat = (t) => Object.keys(cats).find(k => cats[k].includes(t)) || 'other';
  const counts = { read: 0, web: 0, edit: 0, bash: 0, task: 0, todo: 0, other: 0 };
  for (const s of withTool) counts[cat(s.toolName)]++;

  const parts = [];
  if (counts.read > 0) parts.push(L.steps.read(counts.read));
  if (counts.web > 0)  parts.push(L.steps.web(counts.web));
  if (counts.edit > 0) parts.push(L.steps.edit(counts.edit));
  if (counts.bash > 0) parts.push(L.steps.bash(counts.bash));
  if (counts.task > 0) parts.push(L.steps.task(counts.task));

  // Última ação como hint do que tá fazendo agora.
  const last = withTool[withTool.length - 1];
  const lastCat = cat(last.toolName);
  const what = (last.inputSummary || '').slice(0, 40);
  let now = '';
  if (lastCat === 'bash')      now = L.steps.nowBash(what);
  else if (lastCat === 'edit') now = L.steps.nowEdit(what);
  else if (lastCat === 'read') now = L.steps.nowRead;
  else if (lastCat === 'web')  now = L.steps.nowWeb;
  else if (lastCat === 'task') now = L.steps.nowTask;

  // Se rodou tool mas NÃO conseguimos formar frase de progresso (ex.: só tool
  // 'other'), tenta o raciocínio antes do fallback genérico.
  if (parts.length === 0) {
    const lastThought = _extractLastThought(newSteps);
    if (lastThought) return lastThought;
    const otherTools = newSteps.filter(s => s.toolName).map(s => s.toolName);
    return L.steps.executingOps(otherTools.length, [...new Set(otherTools)].join(', '));
  }
  return L.steps.already(parts, now);
}

// Pega o último step assistant com texto e extrai 1ª frase limpa, em PT-BR
// natural — é o raciocínio que o próprio Claude já está produzindo entre
// tools. Limpa markdown leve, código inline, e trunca em ~180 chars
// preferindo terminar em ponto/!/? pra não cortar no meio.
function _extractLastThought(steps) {
  if (!Array.isArray(steps)) return null;
  // último primeiro: percorre do fim
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.type !== 'assistant') continue;
    const raw = String(s.text || '').trim();
    if (!raw) continue;
    const clean = _cleanThought(raw);
    if (clean) return clean;
  }
  return null;
}

function _cleanThought(s) {
  let t = String(s)
    // headers/listas viram texto corrido
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // ênfase **x** / *x* / `x` → x
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    // blocos de código fora: remove fences
    .replace(/```[\s\S]*?```/g, '')
    // colapsa whitespace
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  // se for muito longo, tenta terminar numa quebra de frase
  const MAX = 200;
  if (t.length <= MAX) return t;
  const slice = t.slice(0, MAX);
  const m = slice.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (m && m[0].length >= 40) return m[0].trim();
  return slice.replace(/\s+\S*$/, '') + '…';
}

module.exports = {
  pendingByTaskId,
  inflightByJid,
  AUTH_DOWN_NOTICE,
  AUTH_UP_NOTICE,
  _notifyAuthDown,
  _formatReply,
  _rehydrateZombieTasks,
  _summarizeStepsViaClaude,
  _extractLastThought,
  _cleanThought,
};
