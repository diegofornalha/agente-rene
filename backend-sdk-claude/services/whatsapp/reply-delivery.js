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
const {
  TTS_ENABLED, TTS_MODE, TTS_SYSTEM_PROMPT,
  _sendAsAudio, _sendStreamingAudio, _synthesizeTTS, _mp3ToOggOpus,
} = require('./tts');
const {
  _splitDetails, _splitSummaryBody, _extractCurrentMessage,
} = require('./message-extract');
const {
  _normForDedup, _lastReplyByJid, SEMANTIC_DEDUP_WINDOW_MS,
} = require('./anti-loop');
const convHistory = require('../memory/conversation-history');
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

// ── Loop de entrega — streaming TTS + polling de tasks ──
// Registrado UMA vez por processo (guard _started): antes vivia dentro de
// start() e cada reconnect do Baileys empilhava um setInterval/listener novo
// fechando sobre o sock antigo (morto). Aqui o sock é lido fresco do sock-ref
// a cada tick, então reconexões não quebram a entrega.
let _deliveryStarted = false;
function _startDelivery({ io, taskRunner }) {
  if (_deliveryStarted) return;
  _deliveryStarted = true;

  // ── Socket.IO event handlers — resposta imediata quando delivery funciona ──

  // [DESABILITADO 2026-06-04] _handleTaskDone foi removido do código mas a chamada
  // permaneceu, gerando ReferenceError silencioso a cada task done — algumas tasks
  // ficavam "presas" sem entrega (resposta gerada, mas não enviada ao WhatsApp).
  // O polling de 1.5s abaixo cobre 100% da entrega; este atalho era só pra latência.
  //
  // io.on('task_done', ({ taskId, status, result }) => {
  //   const ctx = pendingByTaskId.get(taskId);
  //   if (!ctx) return;
  //   _handleTaskDone(ctx, taskId, status, result);
  // });

  io.on('task_step', ({ taskId, step }) => {
    // Captura deltas de texto pra streaming TTS futuro.
    const ctx = pendingByTaskId.get(taskId);
    if (!ctx || step.type !== 'assistant') return;
    const text = step.text || '';
    if (!text || !TTS_ENABLED || TTS_MODE === 'none') return;
    // Defensivo: erro de auth nunca vira áudio streaming (o task-runner já
    // sanitiza os steps na origem; isto é cinto e suspensório).
    if (isAuthErrorStrict(text)) return;
    ctx._streamBuffer = (ctx._streamBuffer || '') + text;

    // Streaming TTS: detecta frases completas e envia áudio imediato.
    // Simples: pega texto até o último ". " / "! " / "? " ou ".\n"
    const SENTENCE_END = /([.!?])\s+/g;
    let match;
    let lastEnd = -1;
    let lastDelim = '';
    SENTENCE_END.lastIndex = 0;
    while ((match = SENTENCE_END.exec(ctx._streamBuffer)) !== null) {
      lastEnd = match.index + match[0].length;
      lastDelim = match[1];
    }
    // Só envia se tiver pelo menos uma frase completa (≥5 chars).
    if (lastEnd > 4) {
      const phrase = ctx._streamBuffer.slice(0, lastEnd).trim();
      ctx._streamBuffer = ctx._streamBuffer.slice(lastEnd);
      // Envia áudio sem esperar task completa.
      _sendStreamingAudio(ctx.remoteJid, phrase).catch(() => {});
    }
  });

  // Polling leve (1.5s) como fallback caso Socket.IO não entregue.
  setInterval(async () => {
    const sock = sockRef.getSock();
    if (!sock || !sockRef.isReady() || pendingByTaskId.size === 0) return;

    for (const [taskId, ctx] of [...pendingByTaskId.entries()]) {
      const t = taskRunner.getTask(taskId);
      if (!t) { pendingByTaskId.delete(taskId); continue; }

      // Heartbeat de progresso em LINGUAGEM NATURAL: resumo via Haiku do que o
      // agente fez desde o último heartbeat (delta, não cumulativo). Se nada de
      // novo aconteceu, pula — typing indicator basta. Sem cap: conteúdo real
      // não é ruído.
      const elapsedMs = Date.now() - ctx.startedAt;
      const FIRST_HEARTBEAT_DELAY_MS = 30_000;
      const HEARTBEAT_INTERVAL_MS = 20_000;
      const lastBeatAt = ctx.lastProgressAt || ctx.startedAt;
      const heartbeatDue = (ctx.lastProgressAt
        ? (Date.now() - lastBeatAt) >= HEARTBEAT_INTERVAL_MS
        : elapsedMs >= FIRST_HEARTBEAT_DELAY_MS);

      if (heartbeatDue) {
        const allSteps = t.steps || [];
        const lastIdx = ctx.lastStepIndex ?? 0;
        const newSteps = allSteps.slice(lastIdx);

        console.log(`💓 [hb] task=${taskId.slice(0,8)} elapsed=${Math.round(elapsedMs/1000)}s allSteps=${allSteps.length} newSteps=${newSteps.length} lastIdx=${lastIdx}`);

        if (newSteps.length === 0) {
          // Nada novo desde o último heartbeat — silêncio é melhor que ruído.
          // Avança o relógio mesmo assim pra não martelar log a cada 1.5s.
          ctx.lastProgressAt = Date.now();
        } else {
          ctx.lastProgressAt = Date.now();
          ctx.lastStepIndex = allSteps.length;
          ctx.heartbeatCount = (ctx.heartbeatCount || 0) + 1;

          const msgSpoken = await _summarizeStepsViaClaude(newSteps);
          console.log(`💓 [hb] summary=${msgSpoken ? `"${msgSpoken.slice(0,80)}"` : 'NULL (Haiku falhou ou retornou vazio)'}`);
          if (msgSpoken) {
            try {
              if (TTS_ENABLED && TTS_MODE === 'audio_only') {
                try {
                  const mp3 = await _synthesizeTTS(msgSpoken);
                  const ogg = await _mp3ToOggOpus(mp3);
                  await sock.sendMessage(ctx.remoteJid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
                  _appendConv(`bot→${_jidToRole(ctx.remoteJid)}`, `[áudio heartbeat] ${msgSpoken}`);
                  console.log(`💓 [hb] enviado como áudio`);
                } catch (e) {
                  await sock.sendMessage(ctx.remoteJid, { text: msgSpoken });
                  _appendConv(`bot→${_jidToRole(ctx.remoteJid)}`, msgSpoken);
                  console.log(`💓 [hb] enviado como texto (TTS falhou: ${e.message})`);
                }
              } else {
                await sock.sendMessage(ctx.remoteJid, { text: msgSpoken });
                _appendConv(`bot→${_jidToRole(ctx.remoteJid)}`, msgSpoken);
                console.log(`💓 [hb] enviado como texto`);
              }
            } catch (e) {
              console.warn(`⚠️ [hb] envio falhou: ${e.message}`);
            }
          }
        }
      }

      if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
        pendingByTaskId.delete(taskId);
        if (ctx.typingInterval) clearInterval(ctx.typingInterval);

        // Ressuscitação silenciosa em caso de erro: o user já mandou a pergunta,
        // não devemos pedir reformulação. Recria a task uma vez automaticamente.
        // Se a ressuscitada também falhar (resurrectedOnce já true), aí sim cai
        // no fluxo de envio com a mensagem neutra.
        // Exceção: falha de auth — recriar só queimaria outro 401; cai no fluxo
        // de envio, onde _formatReply devolve o aviso de authDown.
        if (t.status === 'error' && !ctx.resurrectedOnce
            && t.error !== 'claude_auth_down' && !authMonitor.isDown()) {
          console.log(`🩹 Task ${taskId.slice(0,8)} erro definitivo — ressuscitando 1x sem avisar user`);
          const newTask = taskRunner.createTask({
            prompt: t.prompt,
            source: 'whatsapp',
            systemPrompt: TTS_ENABLED ? TTS_SYSTEM_PROMPT : undefined,
            tags: [...(t.tags || []), 'resurrected'],
            maxTurns: 25,
          });
          const newTypingInterval = setInterval(() => {
            sock.sendPresenceUpdate('available')
              .then(() => sock.sendPresenceUpdate('composing', ctx.remoteJid))
              .catch(() => {});
          }, 5000);
          // Mantém a Promise inflight viva — a fila do jid não libera ainda.
          pendingByTaskId.set(newTask.id, {
            remoteJid: ctx.remoteJid,
            startedAt: Date.now(),
            typingInterval: newTypingInterval,
            resolveInflight: ctx.resolveInflight,
            thisInflight: ctx.thisInflight,
            resurrectedOnce: true,
            rawMessage: ctx.rawMessage,
          });
          continue;
        }

        // Libera a fila do jid: a próxima mensagem desse user pode prosseguir.
        if (ctx.resolveInflight) ctx.resolveInflight();
        if (ctx.thisInflight && inflightByJid.get(ctx.remoteJid) === ctx.thisInflight) {
          inflightByJid.delete(ctx.remoteJid);
        }

        // Falha de auth (plano desconectado): não manda erro cru nem "🤔 Hmm",
        // manda o lembrete de reconexão (com rate-limit de 5min por chat) e
        // não polui o convHistory com o episódio.
        if ((t.status === 'error' && t.error === 'claude_auth_down')
            || (t.status === 'done' && isAuthErrorStrict(t.result))) {
          if (t.status === 'done') authMonitor.reportAuthFailure(t.result);
          await _notifyAuthDown(ctx.remoteJid);
          continue;
        }

        const fullReply = _formatReply(t);
        const role = _jidToRole(ctx.remoteJid);
        const ms = Date.now() - ctx.startedAt;

        // ── Hard block: NUNCA enviar áudio/texto se a resposta for vazia/placeholder ──
        // Lição operacional 2026-06-05: agente respondeu "(resposta vazia)" como áudio
        // TTS pra mensagens invisíveis da Diego — bizarro e ruidoso. Também não
        // polui convHistory com placeholder (senão o modelo aprende padrão errado).
        const _hasRealContent = t.status === 'done'
          && t.result && t.result.trim()
          && fullReply !== '(resposta vazia)';
        if (!_hasRealContent && t.status === 'done') {
          console.log(`🤫 Task ${taskId.slice(0,8)} done com resposta vazia — sem envio, sem convHistory`);
          continue;
        }

        // ── Dedup semântico (Diego checkpoint #4 — 2026-06-05) ──
        // Se a mesma resposta normalizada foi enviada pro mesmo jid nos últimos 60s,
        // abortar. Pega "Registrado." × 5 e variações que o prompt sozinho não pega.
        const _norm = _normForDedup(fullReply);
        const _prev = _lastReplyByJid.get(ctx.remoteJid);
        const _now = Date.now();
        if (_norm && _prev && _prev.norm === _norm && (_now - _prev.ts) < SEMANTIC_DEDUP_WINDOW_MS) {
          const _ago = Math.round((_now - _prev.ts) / 1000);
          console.log(`🤫 Dedup semântico — resposta idêntica enviada há ${_ago}s pro ${ctx.remoteJid}, abortando`);
          continue;
        }
        _lastReplyByJid.set(ctx.remoteJid, { norm: _norm, ts: _now });

        // Grava turno no histórico multi-turno (pra próxima msg do mesmo jid).
        // SEMPRE a mensagem crua do interlocutor — nunca o prompt montado.
        // Persistir t.prompt re-aninhava o wrapper de injeção a cada turno
        // (matryoshka), inflando o contexto até exigir /reset (fix 2026-07-02).
        // Fallback _extractCurrentMessage cobre zombies rehidratados sem ctx.
        // Prefixo "Nome: " só em grupo (ctx.senderName) — é rótulo de falante no
        // histórico, não wrapper de injeção; não re-aninha (o wrapper é montado
        // à parte em finalPrompt).
        const _rawMsg = ctx.rawMessage || _extractCurrentMessage(t.prompt) || '';
        convHistory.addTurn('wa', ctx.remoteJid, ctx.senderName ? `${ctx.senderName}: ${_rawMsg}` : _rawMsg, fullReply);

        try {
          await sock.sendPresenceUpdate('paused', ctx.remoteJid);

          // Caminho de erro/cancelado — sem TTS, manda só o texto
          if (t.status !== 'done' || !TTS_ENABLED) {
            await sock.sendMessage(ctx.remoteJid, { text: fullReply });
            console.log(`📤 WhatsApp → ${ctx.remoteJid} (${t.status}, ${ms}ms): ${fullReply.slice(0, 80)}`);
            _appendConv(`bot→${role}`, fullReply);
          } else if (TTS_MODE === 'audio_only') {
            // Modo audio_only: a parte falada vira áudio natural; o bloco
            // "📋 Detalhes:" (números/códigos/IPs) e links soltos vão como
            // texto — dado técnico falado fica robótico.
            const { spoken, details } = _splitDetails(fullReply);
            let ttsOk = false;
            try {
              const mp3 = await _synthesizeTTS(spoken);
              const ogg = await _mp3ToOggOpus(mp3);
              await sock.sendMessage(ctx.remoteJid, {
                audio: ogg,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true,
              });
              _appendConv(`bot→${role}`, `[áudio TTS audio_only] ${spoken.slice(0, 120)}`);
              console.log(`🔊 TTS audio_only → ${ctx.remoteJid}: ${spoken.slice(0, 80)}`);
              ttsOk = true;
            } catch (e) {
              console.error(`❌ TTS audio_only falhou — fallback pra texto:`, e.message);
            }
            if (!ttsOk) {
              // TTS falhou — manda o texto completo pra não deixar o user sem resposta.
              await sock.sendMessage(ctx.remoteJid, { text: fullReply });
              _appendConv(`bot→${role}`, fullReply);
            }
            // [REMOVIDO 2026-06-05] Envio de "texto auxiliar" (📋 Detalhes + 🔗 Links)
            // foi desativado a pedido do Lucas — modo audio_only = APENAS áudio.
            // Se houver dado técnico (URL/IP/código), agente deve verbalizar de forma
            // natural ou aceitar perder o detalhe em vez de poluir com 2 msgs separadas.
          } else if (TTS_MODE === 'full') {
            // Modo full: áudio da resposta inteira + texto como fallback
            try {
              const mp3 = await _synthesizeTTS(fullReply);
              const ogg = await _mp3ToOggOpus(mp3);
              await sock.sendMessage(ctx.remoteJid, {
                audio: ogg,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true,
              });
              _appendConv(`bot→${role}`, `[áudio TTS full] ${fullReply.slice(0, 120)}`);
              console.log(`🔊 TTS full → ${ctx.remoteJid}: ${fullReply.slice(0, 80)}`);
            } catch (e) {
              console.error(`❌ TTS full falhou (segue texto):`, e.message);
            }
            // Envia texto também (pra quem preferir ler)
            await sock.sendMessage(ctx.remoteJid, { text: fullReply });
            console.log(`📤 WhatsApp → ${ctx.remoteJid} (${t.status}, ${ms}ms): ${fullReply.slice(0, 80)}`);
            _appendConv(`bot→${role}`, fullReply);
          } else {
            // Modo summary (padrão): TTS do resumo + texto do corpo
            const { summary, body } = _splitSummaryBody(fullReply);
            try {
              const mp3 = await _synthesizeTTS(summary);
              const ogg = await _mp3ToOggOpus(mp3);
              await sock.sendMessage(ctx.remoteJid, {
                audio: ogg,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true,
              });
              _appendConv(`bot→${role}`, `[áudio TTS resumo] ${summary}`);
              console.log(`🔊 TTS → ${ctx.remoteJid}: ${summary.slice(0, 80)}`);
            } catch (e) {
              console.error(`❌ TTS falhou (segue texto):`, e.message);
            }
            await sock.sendMessage(ctx.remoteJid, { text: body });
            console.log(`📤 WhatsApp → ${ctx.remoteJid} (${t.status}, ${ms}ms): ${body.slice(0, 80)}`);
            _appendConv(`bot→${role}`, body);
          }
        } catch (e) {
          console.error(`❌ WhatsApp send failed:`, e.message);
        }
      }

      // Timeout client-side de 16min (task-runner já aborta em 15min)
      if (Date.now() - ctx.startedAt > 16 * 60 * 1000) {
        pendingByTaskId.delete(taskId);
        if (ctx.typingInterval) clearInterval(ctx.typingInterval);
        if (ctx.resolveInflight) ctx.resolveInflight();
        if (ctx.thisInflight && inflightByJid.get(ctx.remoteJid) === ctx.thisInflight) {
          inflightByJid.delete(ctx.remoteJid);
        }
        try {
          await sock.sendMessage(ctx.remoteJid, { text: '⏱️ Demorou mais que o esperado pra processar. Tô tentando resolver.' });
        } catch (e) { /* ignore */ }
      }
    }
  }, 1500);
}

module.exports = {
  _startDelivery,
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
