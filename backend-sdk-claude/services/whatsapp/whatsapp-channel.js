// Canal WhatsApp via Baileys (WhatsApp Web não-oficial).
// Recebe mensagens DM, cria task no taskRunner e responde com o resultado.
//
// Ativar via .env:
//   WHATSAPP_ENABLED=true
//   WHATSAPP_ALLOWED_NUMBERS=+5511999999999,+5511888888888   (opcional; vazio = libera todo mundo)
//   WHATSAPP_AUTH_DIR=./data/whatsapp-auth                   (opcional)

const path = require('path');
const fs = require('fs-extra');
const memory = require('../memory/memory-store');
const convHistory = require('../memory/conversation-history');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const { spawn } = require('child_process');
const pdfParse = require('pdf-parse');

const metrics = require('../health/metrics');
const authMonitor = require('../health/auth-monitor');
const { isAuthErrorStrict } = authMonitor;
const { classify: classifyIntent, ACTION_SYSTEM_ADDENDUM } = require('../intent-classifier');
const identityStore = require('./identity-store');
const { resolveIdentity } = require('./identity-resolver');
const { prepareTextForTTS: _prepareTextForTTS } = require('../media/tts-sanitizer');

// Binários de mídia resolvidos via PATH por padrão (portável Linux/macOS).
// Sobrescreva com FFMPEG_BIN / WHISPER_BIN / WHISPER_MODEL no .env se estiverem
// fora do PATH (ex.: builds estáticos em ~/bin).
const FFMPEG_BIN     = process.env.FFMPEG_BIN     || 'ffmpeg';
const WHISPER_BIN    = process.env.WHISPER_BIN    || 'whisper-cli';
const WHISPER_MODEL  = process.env.WHISPER_MODEL  || '';
const WHISPER_LANG   = process.env.WHISPER_LANG   || 'auto';

// Imagens recebidas no WhatsApp são persistidas aqui (o handler antes
// descartava imagens — só áudio era baixado). Permite usar a última imagem
// enviada, ex.: trocar a foto de perfil do bot.
const INBOUND_MEDIA_DIR = path.join(__dirname, '..', '..', 'data', 'whatsapp-inbound-media');

// Strings voltadas ao usuário final (TTS, prompts de mídia, heartbeat) vêm do
// locale — selecionado via AGENT_LOCALE (default pt-BR, ver config/locale/).
const L = require('../../config/locale');

const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY  || '';
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const ELEVEN_MODEL    = process.env.ELEVENLABS_MODEL    || 'eleven_multilingual_v2';
const TTS_ENABLED     = !!ELEVEN_API_KEY;
// Modos de saída:
//   'audio_only' = APENAS áudio com resposta inteira (sem texto)
//   'full'       = áudio da resposta inteira + texto completo
//   'summary'    = áudio curto com resumo + texto completo
//   'none'       = só texto, sem áudio
const TTS_MODE        = (process.env.TTS_MODE || 'summary').toLowerCase();

const TTS_SYSTEM_PROMPT_SUMMARY = L.ttsSummary;

const TTS_SYSTEM_PROMPT_FULL = L.ttsFull;

// Modo audio_only: a resposta vira voz. Áudio em linguagem natural; dados
// técnicos precisos vão num bloco "📋 Detalhes:" que é enviado como texto.
const TTS_SYSTEM_PROMPT_AUDIO_ONLY = L.ttsAudioOnly;

// Seleção do systemPrompt conforme o modo de saída (fixo no boot).
const TTS_SYSTEM_PROMPT = TTS_MODE === 'audio_only'
  ? TTS_SYSTEM_PROMPT_AUDIO_ONLY
  : TTS_MODE === 'full'
    ? TTS_SYSTEM_PROMPT_FULL
    : TTS_SYSTEM_PROMPT_SUMMARY;

const QR_PNG_PATH = process.env.WHATSAPP_QR_PNG || '/tmp/whatsapp-qr.png';
const sockRef = require('./sock-ref');
const { CONV_LOG_PATH, _appendConv, _jidToRole } = require('./conv-log');
const {
  _msgContextInfo, _extractQuotedText, _extractText, _extractLinks,
  _splitDetails, _splitSummaryBody, _quotedMediaType, _stripLinkFormatting,
  _extractCurrentMessage,
} = require('./message-extract');

// Allowlist de grupos observados (modo passivo — só loga, não responde).
// Formato: grupoJid1,grupoJid2,... (separados por vírgula, sem espaços).
// Alternativa: definir no .env como WHATSAPP_GROUP_ALLOWLIST=120363xxxx@g.us,...
const GROUP_ALLOWLIST_ENV = process.env.WHATSAPP_GROUP_ALLOWLIST || '';
const GROUP_STORE_PATH = path.join(__dirname, '..', '..', 'data', 'whatsapp-groups.json');

// Grupos "abertos": agente responde a TUDO (sem precisar de @ ou menção a René/Hermes).
// Anti-loop e bloqueio de bots conhecidos continuam valendo.
// Config exclusivamente via .env WHATSAPP_OPEN_GROUPS (JIDs separados por vírgula) —
// sem JIDs hardcoded, pra clones/instâncias novas não herdarem grupos alheios.
const OPEN_GROUPS = new Set(
  (process.env.WHATSAPP_OPEN_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean)
);

const logger = pino({ level: 'warn' });

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

// ── Store de grupos observados (persistido em JSON) ──
let observedGroups = new Map(); // groupJid → { name, addedAt }

// Carrega allowlist do .env na inicialização.
function _loadGroupAllowlist() {
  if (GROUP_ALLOWLIST_ENV) {
    GROUP_ALLOWLIST_ENV.split(',').forEach(jid => {
      const g = jid.trim();
      if (g) observedGroups.set(g, { name: g, addedAt: null });
    });
  }
}

// Persiste o map de volta no JSON.
function _saveGroupStore() {
  const obj = Object.fromEntries(
    [...observedGroups.entries()].map(([k, v]) => [k, v])
  );
  fs.writeFile(GROUP_STORE_PATH, JSON.stringify(obj, null, 2)).catch(e =>
    console.error('group store save failed:', e.message)
  );
}

// Carrega do arquivo na inicialização.
function _loadGroupStore() {
  try {
    const raw = fs.readFileSync(GROUP_STORE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      observedGroups.set(k, v);
    }
  } catch (_) { /* arquivo não existe ainda — ok */ }
}

function isGroupObserved(jid) {
  return observedGroups.has(jid);
}

function addObservedGroup(jid, name, { open } = {}) {
  const prev = observedGroups.get(jid) || {};
  const entry = {
    name: name || prev.name || jid,
    addedAt: prev.addedAt || new Date().toISOString(),
  };
  const openVal = open !== undefined ? open : prev.open;
  if (openVal !== undefined) entry.open = openVal;
  observedGroups.set(jid, entry);
  _saveGroupStore();
  return entry;
}

// Marca/desmarca um grupo como "aberto" (responde a todos sem @) em runtime,
// sem restart. Cria a entrada observada se ainda não existir.
function setGroupOpen(jid, open = true) {
  const prev = observedGroups.get(jid) || { name: jid, addedAt: new Date().toISOString() };
  prev.open = open;
  observedGroups.set(jid, prev);
  _saveGroupStore();
  return { jid, open };
}

function removeObservedGroup(jid) {
  observedGroups.delete(jid);
  _saveGroupStore();
}

function listObservedGroups() {
  return [...observedGroups.entries()].map(([jid, v]) => ({ jid, name: v.name, addedAt: v.addedAt }));
}

// Checa se o remetente é um bot conhecido (evita loop agente-agente).
function _isFromKnownBot(msg) {
  const participant = msg.key.participant || '';
  const participantNumber = participant.split('@')[0]?.split(':')[0];
  if (KNOWN_BOT_JIDS.has(participant)) return true;
  if (participantNumber && KNOWN_BOT_PREFIXES.some(p => participantNumber === p)) return true;
  return false;
}

// Detecta se a mensagem ENDEREÇA o bot (menção @ / reply a msg do bot / nome),
// SEM o filtro de bot-conhecido. Funciona pra qualquer tipo de mídia.
function _isGroupAddressed(msg) {
  // Grupo aberto (WHATSAPP_OPEN_GROUPS): bypass total do filtro de menção.
  if (OPEN_GROUPS.has(msg.key.remoteJid)) return true;
  // Grupo aberto via flag VIVA no whatsapp-groups.json ({ open: true }) — lido em
  // runtime, sem precisar reiniciar. É o caminho pra "funcionar de primeira".
  if (observedGroups.get(msg.key.remoteJid)?.open) return true;
  const ctx = _msgContextInfo(msg);
  const botNumber = sock?.user?.id?.split(':')[0];
  // 1. Menção direta via @mention
  const mentions = ctx?.mentionedJid || [];
  if (botNumber && mentions.some(jid => jid.startsWith(botNumber))) return true;
  // 2. Reply direto a uma mensagem do bot
  if (ctx?.quotedMessage && ctx?.participant && botNumber && ctx.participant.startsWith(botNumber)) return true;
  // 3. Texto contém "René"/"Hermes" como chamado direto
  const text = _extractText(msg) || '';
  if (/(?:^|[.,!?\s])(?:ren[eé]|hermes)(?:[.,!?\s]|$)/i.test(text)) return true;
  return false;
}

function _isGroupMentioned(msg) {
  // NUNCA responder a bots conhecidos por este caminho (humanos). Agente↔agente
  // em grupo é tratado à parte, com limite de turnos (ver handler principal).
  if (_isFromKnownBot(msg)) {
    console.log(`🤖 Ignorando mensagem de bot conhecido em grupo: ${msg.key.participant}`);
    return false;
  }
  return _isGroupAddressed(msg);
}

// [REMOVIDO 2026-06-04] A função `_jidToName(jid)` foi substituída por
// `resolveIdentity({ jid, sock, msg })` em `./identity-resolver.js`, que faz
// resolução em 2 etapas (LID→número via Baileys, número→pessoa via
// `data/contacts.json`). A versão hardcoded tinha 2 bugs:
//   (a) misturava LIDs e números na mesma lista de `includes()`, criando
//       contradição interna (mesma pessoa, nomes diferentes conforme o
//       formato do JID que o WhatsApp mandasse);
//   (b) era chamada com `remoteJid` no handler de upsert, que em grupo é o
//       JID do grupo (`@g.us`), não do participante — sempre retornava null.
// Pra adicionar/atualizar identidades, edite `data/contacts.json` ou use a
// skill `hermes-contato-mapear`.

let sock = null;
let isReady = false;
// Reconnect backoff state — exponential cap with ±20% jitter. Without this,
// uma outage transiente do Baileys disparava setTimeout(start, 3000) em loop
// num thundering-herd contra a WA Web API durante o restart geral do PM2.
let _reconnectAttempts = 0;
const _RECONNECT_BASE_MS = 3000;
const _RECONNECT_MAX_MS  = 5 * 60_000; // 5 min teto
function _nextReconnectDelay() {
  const exp = Math.min(_RECONNECT_MAX_MS, _RECONNECT_BASE_MS * Math.pow(2, _reconnectAttempts));
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}
const pendingByTaskId = new Map();   // taskId → { remoteJid, startedAt }
const inflightByJid   = new Map();   // remoteJid → Promise (preserva ordem por user)
const _lastReplyByJid = new Map();   // remoteJid → { norm, ts } — dedup semântico anti-loop
const SEMANTIC_DEDUP_WINDOW_MS = 60_000;

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
  if (!sock || !isReady) {
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

// Normalização leve pra dedup: lowercase, sem pontuação/whitespace, cap em 200 chars.
// Pega "Registrado." === "Registrado" === "registrado!", mas não confunde respostas
// genuinamente diferentes.
function _normForDedup(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s.,!?;:\-—…()\[\]"'`]/g, '')
    .slice(0, 200);
}

function _normalizeNumber(n) {
  return String(n || '').replace(/\D/g, '');
}

function _parseAllowed() {
  const raw = process.env.WHATSAPP_ALLOWED_NUMBERS || '';
  return raw.split(',').map(s => _normalizeNumber(s)).filter(Boolean);
}

// ── Allowlist de DM persistida em runtime (números OU LIDs, só dígitos) ──
// Complementa WHATSAPP_ALLOWED_NUMBERS (.env): o .env é o seed fixo do boot;
// este store guarda adições feitas em runtime (via API/skill) sem editar .env
// nem reiniciar. Persistido em data/whatsapp-dm-allowlist.json.
const DM_ALLOWLIST_PATH = path.join(__dirname, '..', '..', 'data', 'whatsapp-dm-allowlist.json');
let dmAllowExtra = new Set();

function _loadDmAllowlist() {
  try {
    const arr = JSON.parse(fs.readFileSync(DM_ALLOWLIST_PATH, 'utf8'));
    if (Array.isArray(arr)) arr.forEach(n => { const d = _normalizeNumber(n); if (d) dmAllowExtra.add(d); });
  } catch (_) { /* arquivo não existe ainda — ok */ }
}

function _saveDmAllowlist() {
  fs.writeFile(DM_ALLOWLIST_PATH, JSON.stringify([...dmAllowExtra], null, 2)).catch(e =>
    console.error('dm allowlist save failed:', e.message));
}

// Conjunto efetivo = entradas do .env ∪ adições de runtime.
function _allowedSet() {
  return new Set([..._parseAllowed(), ...dmAllowExtra]);
}

function _isAllowed(jid) {
  const set = _allowedSet();
  if (set.size === 0) return true; // lista totalmente vazia = libera todos
  return set.has(_normalizeNumber(jid.split('@')[0]));
}

// API pública pra gerenciar a allowlist de DM em runtime.
function addDmAllowed(entry) {
  const d = _normalizeNumber(entry);
  if (!d) return { ok: false, error: 'número/LID inválido (vazio após normalizar)' };
  const already = _allowedSet().has(d);
  dmAllowExtra.add(d);
  _saveDmAllowlist();
  console.log(`✅ DM allowlist: + ${d}${already ? ' (já permitido)' : ''}`);
  return { ok: true, entry: d, alreadyAllowed: already, effectiveTotal: _allowedSet().size };
}

function removeDmAllowed(entry) {
  const d = _normalizeNumber(entry);
  if (!d) return { ok: false, error: 'número/LID inválido' };
  const removedFromRuntime = dmAllowExtra.delete(d);
  if (removedFromRuntime) _saveDmAllowlist();
  const stillInEnv = _parseAllowed().includes(d);
  console.log(`🗑️  DM allowlist: - ${d} (runtime=${removedFromRuntime}, ainda no .env=${stillInEnv})`);
  return { ok: true, entry: d, removedFromRuntime, stillInEnv };
}

function listDmAllowed() {
  return { env: _parseAllowed(), runtime: [...dmAllowExtra], effective: [..._allowedSet()] };
}

// ── Transcrição de áudio (ffmpeg → whisper-cli) ──
function _runCmd(bin, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${label} exit=${code}: ${stderr.slice(-300)}`)));
  });
}

// ── TTS via ElevenLabs (mp3) → OGG/Opus pra mandar como PTT no WhatsApp ──
async function _synthesizeTTS(text) {
  if (!TTS_ENABLED) throw new Error('ELEVENLABS_API_KEY ausente');
  const spoken = _prepareTextForTTS(text);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: spoken,
      model_id: ELEVEN_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function _mp3ToOggOpus(mp3Buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN,
      ['-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    ff.stdout.on('data', c => chunks.push(c));
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('exit', code => code === 0
      ? resolve(Buffer.concat(chunks))
      : reject(new Error(`ffmpeg mp3→ogg exit=${code}: ${stderr.slice(-200)}`)));
    ff.stdin.end(mp3Buf);
  });
}

// Memory shortcuts: "lembre que X" / "anota: X" → MEMORY.md;
// "sobre mim: X" → USER.md; "esquece X" → remove linha que contém X.
// Retorna () => Promise<string> com a resposta pronta, ou null se não é shortcut.
function _memoryShortcut(text) {
  const t = String(text).trim();

  const mRemember = t.match(/^(?:lembre[- ]?(?:te|se)?\s+(?:que|de)|anota[:,]?|memo[:,]?)\s+(.+)/i);
  if (mRemember) {
    const fact = mRemember[1].trim();
    return async () => {
      const r = memory.appendToMd('MEMORY.md', fact);
      return r.ok && !r.dedup
        ? `✅ anotado no MEMORY.md (${r.length}/2200 chars)`
        : r.dedup ? `ℹ️ já estava anotado` : `❌ falha: ${r.reason}`;
    };
  }

  const mUser = t.match(/^(?:sobre\s+mim|meu\s+perfil|user[:,]?)\s*[:,]?\s+(.+)/i);
  if (mUser) {
    const fact = mUser[1].trim();
    return async () => {
      const r = memory.appendToMd('USER.md', fact);
      return r.ok && !r.dedup
        ? `✅ anotado no USER.md (${r.length}/1375 chars)`
        : r.dedup ? `ℹ️ já estava no perfil` : `❌ falha: ${r.reason}`;
    };
  }

  const mForget = t.match(/^(?:esquece|remova?|apaga)\s+(?:que\s+|isso[:,]?\s+)?(.+)/i);
  if (mForget) {
    const substr = mForget[1].trim();
    return async () => {
      const memR = memory.removeLineFromMd('MEMORY.md', substr);
      const usrR = memory.removeLineFromMd('USER.md', substr);
      if (memR.ok || usrR.ok) return `✅ removido (${memR.ok ? 'MEMORY' : 'USER'}.md)`;
      return `❌ não achei nada com "${substr}"`;
    };
  }

  if (/^(o\s+que\s+voc[eê]\s+(?:sabe|lembra)|mostrar?\s+(mem[oó]ria|user)|cat\s+memory)/i.test(t)) {
    return async () => {
      const snap = memory.snapshotMd();
      return [
        snap.user   ? `## USER.md\n${snap.user}`   : '',
        snap.memory ? `## MEMORY.md\n${snap.memory}` : '',
      ].filter(Boolean).join('\n\n') || '(memória vazia)';
    };
  }

  // "liste skills" → lista skills disponíveis em .claude/skills/
  if (/^(liste|mostre|lista)\s+(?:as?\s+)?skills/i.test(t)) {
    return async () => {
      const { glob } = require('fs');
      const { promisify } = require('util');
      const globAsync = promisify(glob);
      const fs2 = require('fs-extra');
      const SKILLS_ROOT = path.join(__dirname, '..', '..', '.claude', 'skills');
      let skills = [];
      try {
        const files = await globAsync('**/*.md', { cwd: SKILLS_ROOT });
        skills = files.map(f => f.replace(/\.md$/, '').replace(/\//g, ' / ')).filter(s => !s.startsWith('_'));
      } catch (_) {}
      if (skills.length === 0) return 'Nenhuma skill local encontrada. Use /skill-name pra ativar.';
      return `📋 Skills disponíveis (${skills.length}):\n` + skills.map(s => `  • ${s}`).join('\n');
    };
  }

  // "o que você sabe sobre X" → busca no MEMORY.md e USER.md por X
  const mKnow = t.match(/^(?:o\s+que\s+(?:voc[eê]|meu)\s+(?:sabe|lembra|conhece|tem)\s+(?:sobre|de|do|da)\s+)(.+)/i);
  if (mKnow && t.length > 5) {
    const query = mKnow[1].trim();
    if (query.length > 2 && !query.includes('skills') && !query.includes('memória')) {
      return async () => {
        const snap = memory.snapshotMd();
        const search = query.toLowerCase();
        const memLines = snap.memory?.split('\n').filter(l => l.toLowerCase().includes(search)) || [];
        const usrLines = snap.user?.split('\n').filter(l => l.toLowerCase().includes(search)) || [];
        if (memLines.length === 0 && usrLines.length === 0) return `🤔 Não encontrei nada sobre "${query}" na memória.`;
        return [`🔍 Memórias sobre "${query}":`, ...memLines.map(l => `  MEM: ${l}`), ...usrLines.map(l => `  USER: ${l}`)].join('\n');
      };
    }
  }

  // "silencia X" → adiciona preferência de silêncio ao USER.md
  const mSilence = t.match(/^(?:silencia|não\s+(?:manda|envia|mostre))\s+(.+)/i);
  if (mSilence) {
    const item = mSilence[1].trim();
    return async () => {
      const r = memory.appendToMd('USER.md', `não mencione: ${item}`);
      return r.ok ? `🔇 silêncio ativado: "${item}"` : `❌ falha: ${r.reason}`;
    };
  }

  // "esquece o último" → undo stack: remove última linha do MEMORY.md
  const mUndo = /^(?:esquece\s+(?:o\s+)?último|undo|desfaz)/i.test(t);
  if (mUndo) {
    return async () => {
      const snap = memory.snapshotMd();
      const memLines = snap.memory?.split('\n').filter(l => l.trim()) || [];
      if (memLines.length === 0) return 'Nada pra desfazer — memória vazia.';
      const last = memLines.pop();
      memory.writeMd('MEMORY.md', memLines.join('\n'));
      return `↩️ desfiz: ${last}`;
    };
  }

  // "@divida <cnpj>" → cria caso de dívida ativa e pede CSV do Regularize
  const mDivida = t.match(/^@divida\s+(\d[\d.\/\-]+)/i);
  if (mDivida) {
    const cnpjRaw = mDivida[1];
    const dividaPipeline = require('../../src/pipelines/divida-ativa');
    return async () => {
      const cnpj = dividaPipeline.normalizeCnpj(cnpjRaw);
      if (!cnpj) return `❌ CNPJ inválido: "${cnpjRaw}" — formato esperado: 14 dígitos (XX.XXX.XXX/XXXX-XX)`;
      const existing = await dividaPipeline.getCase(cnpjRaw);
      if (existing && existing.status === 'aguardando_csv') {
        return `⏳ Caso ${existing.id} (${cnpj}) já existe — aguardando CSV do Regularize.\n\nEnvie o CSV aqui que eu processo automaticamente.`;
      }
      if (existing && existing.status === 'processado') {
        return `✅ Caso ${existing.id} (${cnpj}) já foi processado.\n\n${existing.ledger ? `Consolidado: R$ ${existing.ledger.total_vivo.toLocaleString('pt-BR', {minimumFractionDigits:2})}` : ''}\n\nPra reprocessar, envie um novo CSV.`;
      }
      const caseObj = await dividaPipeline.createCase(cnpjRaw);
      return `📋 Caso ${caseObj.id} criado para CNPJ ${cnpj}\n\nAgora preciso do **CSV do Regularize** (Relatório Consolidado da Dívida Ativa da União e do FGTS).\n\nEnvie o arquivo CSV aqui que eu rodo o pipeline completo: parser → prescrição → transação → DC → judicial → motor econômico → diagnóstico rápido.`;
    };
  }

  // "limpa sessão" → limpa histórico multi-turno da conversa atual
  if (/^(limpa\s+(?:sessão|conversa|contexto)|reset\s+(?:chat|conversation))/i.test(t)) {
    return async () => {
      const snap = convHistory.stats();
      // Não temos remoteJid aqui — user pode pedir antes de receber resposta.
      // Marca undo geral (todas sessões) pedindo confirmação.
      return '🗑️ Use "sim, limpa" pra confirmar limpeza de sessão.';
    };
  }

  return null;
}

// Streaming TTS: envia áudio assim que uma frase completa é detectada.
// Não bloqueia — roda em background.
// Envia texto como áudio TTS (usado pra erros/avisos em modo audio_only).
async function _sendAsAudio(remoteJid, text) {
  if (!sock || !isReady) return;
  try {
    const mp3 = await _synthesizeTTS(text);
    const ogg = await _mp3ToOggOpus(mp3);
    await sock.sendMessage(remoteJid, {
      audio: ogg,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    });
    console.log(`🔊 [sendAsAudio] → ${remoteJid}: ${text.slice(0, 60)}`);
  } catch (e) {
    // Fallback pra texto se TTS falhar.
    console.warn(`⚠️ _sendAsAudio TTS falhou, fallback texto: ${e.message}`);
    await sock.sendMessage(remoteJid, { text }).catch(() => {});
  }
}

async function _sendStreamingAudio(remoteJid, phrase) {
  if (!sock || !isReady) return;
  try {
    const mp3 = await _synthesizeTTS(phrase);
    const ogg = await _mp3ToOggOpus(mp3);
    await sock.sendMessage(remoteJid, {
      audio: ogg,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    });
    console.log(`🔊 [streaming] → ${remoteJid}: ${phrase.slice(0, 60)}`);
  } catch (e) {
    // Silencioso — streaming é best-effort.
    console.warn(`⚠️ streaming TTS falhou: ${e.message}`);
  }
}

async function _transcribeAudio(msg) {
  const ts = Date.now();
  const oggPath = `/tmp/wa-audio-${ts}.ogg`;
  const txtPrefix = `/tmp/wa-audio-${ts}`;
  const txtPath = `${txtPrefix}.txt`;

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
  await fs.writeFile(oggPath, buffer);

  // Estratégias de transcrição: cada uma com parâmetros ffmpeg/whisper diferentes.
  // Se a primeira falhar ou retornar vazio, tenta a próxima antes de desistir.
  const strategies = [
    { ar: '16000', ac: '1', whisperExtra: [] },                        // padrão: 16kHz mono
    { ar: '16000', ac: '1', whisperExtra: ['-bs', '5', '-bo', '5'] },  // beam search mais amplo
    { ar: '8000',  ac: '1', whisperExtra: [] },                        // downsample agressivo (áudio ruidoso)
  ];

  let lastErr = null;

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const wavPath = `/tmp/wa-audio-${ts}-attempt${i}.wav`;
    try {
      await _runCmd(FFMPEG_BIN, ['-y', '-i', oggPath, '-ar', s.ar, '-ac', s.ac, '-c:a', 'pcm_s16le', wavPath], 'ffmpeg');
      await _runCmd(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wavPath, '-l', WHISPER_LANG, '-otxt', '-of', txtPrefix, '-nt', ...s.whisperExtra], 'whisper');
      const text = (await fs.readFile(txtPath, 'utf8')).trim();
      if (text) return text;
      console.warn(`⚠️ transcrição tentativa ${i + 1}/${strategies.length}: retornou vazio, tentando próxima…`);
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ transcrição tentativa ${i + 1}/${strategies.length} falhou: ${e.message}, tentando próxima…`);
    } finally {
      fs.unlink(wavPath).catch(() => {});
      fs.unlink(txtPath).catch(() => {});
    }
  }

  // Limpeza do arquivo original
  fs.unlink(oggPath).catch(() => {});

  if (lastErr) throw lastErr;
  return null; // todas as tentativas retornaram vazio
}

// ── Processamento automático de vídeo ──
// Extrai frames + transcreve áudio, descreve frames via Vision API.
// Retorna texto descritivo combinado (transcrição + descrição visual).
async function _processVideo(videoPath, duration) {
  const ts = Date.now();
  const framesDir = `/tmp/vframes-${ts}`;
  const wavPath = `/tmp/va-${ts}.wav`;
  const txtPrefix = `/tmp/va-${ts}`;
  const txtPath = `${txtPrefix}.txt`;

  await fs.ensureDir(framesDir);

  // Intervalo de frames: ~1 a cada 5s, máximo 8 frames
  const interval = Math.max(3, Math.min(10, Math.ceil((duration || 30) / 8)));

  const parts = [];

  // 1) Extrai áudio e transcreve
  let transcription = '';
  try {
    await _runCmd(FFMPEG_BIN, ['-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], 'ffmpeg-audio');
    // Tenta transcrever com as mesmas estratégias de áudio
    const strategies = [
      { ar: '16000', ac: '1', whisperExtra: [] },
      { ar: '16000', ac: '1', whisperExtra: ['-bs', '5', '-bo', '5'] },
      { ar: '8000',  ac: '1', whisperExtra: [] },
    ];
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const attemptWav = `/tmp/va-${ts}-a${i}.wav`;
      try {
        await _runCmd(FFMPEG_BIN, ['-y', '-i', wavPath, '-ar', s.ar, '-ac', s.ac, '-c:a', 'pcm_s16le', attemptWav], 'ffmpeg');
        await _runCmd(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', attemptWav, '-l', WHISPER_LANG, '-otxt', '-of', txtPrefix, '-nt', ...s.whisperExtra], 'whisper');
        const t = (await fs.readFile(txtPath, 'utf8')).trim();
        if (t) { transcription = t; break; }
      } catch (_) {} finally {
        fs.unlink(attemptWav).catch(() => {});
        fs.unlink(txtPath).catch(() => {});
      }
    }
  } catch (e) {
    console.warn(`⚠️ vídeo: extração de áudio falhou: ${e.message}`);
  }

  if (transcription) {
    parts.push(`Transcrição do áudio: ${transcription}`);
  }

  // 2) Extrai frames e descreve via Vision API
  try {
    await _runCmd(FFMPEG_BIN, [
      '-y', '-i', videoPath,
      '-vf', `fps=1/${interval}`,
      '-frames:v', '8',
      '-q:v', '3',
      `${framesDir}/f%02d.jpg`
    ], 'ffmpeg-frames');

    const frameFiles = (await fs.readdir(framesDir))
      .filter(f => f.endsWith('.jpg'))
      .sort();

    if (frameFiles.length > 0) {
      const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
      if (anthropicKey) {
        const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
        const imageContent = [];
        for (const f of frameFiles) {
          const buf = await fs.readFile(path.join(framesDir, f));
          imageContent.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') }
          });
        }
        imageContent.push({
          type: 'text',
          text: L.videoDescribePrompt(frameFiles.length)
        });

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 400,
            messages: [{ role: 'user', content: imageContent }]
          })
        });

        if (res.ok) {
          const data = await res.json();
          const desc = data.content?.[0]?.text;
          if (desc) parts.push(`Descrição visual: ${desc}`);
        } else {
          console.warn(`⚠️ Vision API vídeo: ${res.status}`);
        }
      }
    }
  } catch (e) {
    console.warn(`⚠️ vídeo: extração de frames falhou: ${e.message}`);
  }

  // Cleanup
  fs.remove(framesDir).catch(() => {});
  fs.unlink(wavPath).catch(() => {});

  if (parts.length === 0) return null;
  return parts.join('\n');
}

// Tipos de mídia do WhatsApp que persistimos em disco, com a extensão.
const _MEDIA_EXT = {
  imageMessage: 'jpg',
  videoMessage: 'mp4',
  audioMessage: 'ogg',
  stickerMessage: 'webp',
  documentMessage: null, // extensão derivada do fileName
};

// Baixa e persiste em disco QUALQUER mídia recebida no WhatsApp
// (imagem, vídeo, áudio, figurinha, documento).
// Retorna { path, kind, bytes } ou null se não houver mídia / falhar.
async function _saveInboundMedia(msg, role) {
  const m = msg.message || {};
  const kind = Object.keys(_MEDIA_EXT).find(k => m[k]);
  if (!kind) return null;
  try {
    await fs.ensureDir(INBOUND_MEDIA_DIR);
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
    const safeRole = String(role).replace(/[^\w.+-]/g, '_');
    let ext = _MEDIA_EXT[kind];
    if (!ext) {
      const fn = m.documentMessage?.fileName || '';
      ext = (fn.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    }
    const dest = path.join(INBOUND_MEDIA_DIR, `${safeRole}-${Date.now()}.${ext}`);
    await fs.writeFile(dest, buffer);
    console.log(`💾 WhatsApp mídia salva (${kind}): ${dest} (${buffer.length} bytes)`);
    return { path: dest, kind, bytes: buffer.length };
  } catch (e) {
    console.warn(`⚠️ falha ao salvar mídia inbound: ${e.message}`);
    return null;
  }
}

async function start({ io, taskRunner }) {
  const authDir = process.env.WHATSAPP_AUTH_DIR
    || path.join(__dirname, '..', '..', 'data', 'whatsapp-auth');
  await fs.ensureDir(authDir);
  await fs.ensureDir(path.dirname(CONV_LOG_PATH));
  console.log(`📒 WhatsApp conv log: ${CONV_LOG_PATH}`);

  // Carrega grupos observados (do arquivo + .env).
  _loadGroupStore();
  _loadGroupAllowlist();
  _loadDmAllowlist();
  if (observedGroups.size > 0) {
    console.log(`👁️ Grupos observados: ${[...observedGroups.keys()].join(', ')}`);
  }

  // Identity store (persons + numbers do data/contacts.json).
  identityStore.loadContacts();
  console.log(`🪪 Identity store: ${Object.keys(identityStore.getAllPersons()).length} pessoas, ${Object.keys(identityStore.getAllNumbers()).length} números`);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📱 WhatsApp: usando Baileys protocol v${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,    // controlamos manualmente p/ render mais limpo
    browser: ['Hermes', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
  sockRef.setSock(sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Propagar pra connection-status service (se registrado)
    try { require('../health/connection-status').onConnectionUpdate(update); } catch (_) {}

    if (qr) {
      QRCode.toFile(QR_PNG_PATH, qr, { width: 512, margin: 2 })
        .then(() => console.log(`📱 WhatsApp QR atualizado: ${QR_PNG_PATH}`))
        .catch(e => console.error('QR PNG save failed:', e.message));
      console.log('\n📱 WhatsApp: escaneie o QR abaixo no app (Configurações → Aparelhos conectados):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isReady = true;
      sockRef.setReady(true);
      _reconnectAttempts = 0; // reset backoff — conexão estável
      metrics.setWhatsAppConnected(true);
      const me = sock.user?.id?.split(':')[0] || '?';
      console.log(`✅ WhatsApp conectado como +${me}`);

      // Presença "available" — envia AQUI (pós-open) em vez de
      // markOnlineOnConnect, porque no boot automático me.name ainda não
      // está carregado e o Baileys ignora o request ("no name present").
      // Sem estar available, o indicador de "digitando" não aparece pros
      // contatos (WhatsApp exige presença online pra mostrar chatstate).
      sock.sendPresenceUpdate('available')
        .then(() => console.log('✅ Presença "available" enviada'))
        .catch(e => console.warn('⚠️  Falha ao enviar presença available:', e.message));

      // Ativa confirmação de leitura (check azul) na conta
      sock.updateReadReceiptsPrivacy('all')
        .then(() => console.log('✅ Confirmação de leitura (check azul) ativada'))
        .catch(e => console.warn('⚠️  Falha ao ativar read receipts:', e.message));

      // Rehidrata ctx de tasks WhatsApp que sobreviveram a restart — senão
      // ficam órfãs (sem heartbeat, sem entrega). Roda 1x por conexão.
      try { _rehydrateZombieTasks(taskRunner); } catch (e) { console.warn('⚠️ Rehidratação falhou:', e.message); }
    }

    if (connection === 'close') {
      isReady = false;
      sockRef.setReady(false);
      metrics.setWhatsAppConnected(false);
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        _reconnectAttempts++;
        const delay = _nextReconnectDelay();
        console.warn(`⚠️  WhatsApp desconectou (code=${code}). reconectar em ${Math.round(delay/1000)}s (attempt #${_reconnectAttempts})`);
        setTimeout(() => start({ io, taskRunner }).catch(e => console.error('reconnect failed:', e)), delay);
      } else {
        console.warn(`⚠️  WhatsApp desconectou (code=${code}). não reconectar (loggedOut)`);
        console.error('❌ WhatsApp: deslogado. Apague data/whatsapp-auth/ e reinicie pra novo QR.');
      }
    }
  });

  // Dedupe robusto: LRU de últimas 200 msg.key.id.
// Evita reprocessamento em reconnect Baileys (messages.upsert pode re-enviar).
const MAX_SEEN_IDS = 200;
const _seenMsgIds = [];
function _isDuplicate(msgKey) {
  const id = msgKey.id;
  if (_seenMsgIds.includes(id)) return true;
  _seenMsgIds.push(id);
  if (_seenMsgIds.length > MAX_SEEN_IDS) _seenMsgIds.shift();
  return false;
}

sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      // Unwrap documentWithCaptionMessage — Baileys envelopa PDFs/docs com
      // caption nesse wrapper; sem isso o _saveInboundMedia não acha documentMessage.
      if (msg.message.documentWithCaptionMessage?.message?.documentMessage) {
        msg.message.documentMessage = msg.message.documentWithCaptionMessage.message.documentMessage;
      }

      if (msg.key.fromMe) continue;
      if (_isDuplicate(msg.key)) continue; // dedupe LRU

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === 'status@broadcast') continue;
      // ── Grupos: só responde em grupos observados e quando mencionado ──
      const isGroup = remoteJid.endsWith('@g.us');
      // Transcrição de áudio de grupo: computada na decisão de resposta (pra
      // detectar chamado falado "Hermes/René") e reusada no processamento,
      // evitando transcrever o mesmo áudio duas vezes.
      let preAudioTranscript = null;
      if (isGroup) {
        if (!isGroupObserved(remoteJid)) {
          // Grupo não está na allowlist — ignora silenciosamente
          continue;
        }
        // Decide se responde:
        //  - Humano → regra normal (_isGroupMentioned: menção/reply/nome).
        //  - Bot conhecido (agente↔agente) → SÓ se endereçar o bot E dentro do
        //    limite de turnos bot↔bot. Permite troca curta entre agentes no
        //    grupo (inclusive ÁUDIO), com freio pra não virar ping-pong infinito.
        const sender = msg.key.participant || remoteJid;
        const fromKnownBot = _isFromKnownBot(msg);

        // Áudio em grupo (humano OU agente): transcreve ANTES de decidir. A
        // checagem de nome ("Hermes"/"René") roda em texto, vazio num áudio —
        // então um chamado FALADO dentro do áudio nunca disparava resposta (só
        // logava passivo). Inclui bots conhecidos: é assim que o René responde a
        // um áudio do Jarvis que diz "Hermes" no grupo. Transcreve 1x e reusa
        // pra (a) detectar o chamado, (b) logar, (c) evitar re-transcrição.
        if (msg.message?.audioMessage) {
          try {
            preAudioTranscript = await _transcribeAudio(msg);
          } catch (e) {
            console.warn(`⚠️ transcrição de áudio em grupo falhou: ${e.message}`);
          }
        }
        const audioAddressesBot = !!preAudioTranscript &&
          /(?:^|[.,!?\s])(?:ren[eé]|hermes)(?:[.,!?\s]|$)/i.test(preAudioTranscript);

        let respond;
        if (fromKnownBot) {
          // agente↔agente: responde a ÁUDIO (voice note é deliberado — igual ao
          // DM, que responde a qualquer áudio) OU quando endereçado por
          // texto/menção/reply. Heartbeats de status são TEXTO, então não
          // disparam. Sempre com o freio de turnos bot↔bot (anti-loop).
          const hasAudio = !!msg.message?.audioMessage;
          respond = (hasAudio || _isGroupAddressed(msg)) && _checkDmBotAntiLoop(`grp:${remoteJid}:${sender}`);
        } else {
          // Responde se mencionado/reply/nome em texto OU se o nome foi FALADO no áudio.
          respond = _isGroupMentioned(msg) || audioAddressesBot;
        }
        if (!respond) {
          // Loga passivamente pra contexto. Áudio NÃO tem texto pra registrar —
          // usa a transcrição feita acima, senão o áudio some por completo.
          const groupText = _extractText(msg);
          if (groupText) {
            _appendConv(`grupo:${remoteJid}/${sender}`, groupText);
          } else if (preAudioTranscript) {
            _appendConv(`grupo:${remoteJid}/${sender}`, `[áudio ${msg.message.audioMessage.seconds || 0}s] ${preAudioTranscript}`);
          }
          continue;
        }
        // ── Anti-loop de grupo (humanos) ── grupos abertos pulam; bots conhecidos
        // já passaram pelo freio de turnos bot↔bot acima, então não re-aplicam este.
        if (!OPEN_GROUPS.has(remoteJid) && !fromKnownBot && !_checkGroupAntiLoop(remoteJid)) {
          console.log(`🛑 Anti-loop: ignorando menção em ${remoteJid} (cooldown ativo)`);
          continue;
        }
      }

      if (!isGroup && !_isAllowed(remoteJid)) {
        console.log(`🚫 WhatsApp: número não autorizado ${remoteJid}`);
        continue;
      }

      // ── Anti-loop DM agente-agente: conversa com bot conhecido inicia e fecha ──
      // O remetente está na allowlist (passou acima), mas se for um bot conhecido
      // (René↔Jarvis/Lucrécia por DM), limita os turnos pra não loopar infinito.
      if (!isGroup && _jidIsKnownBot(remoteJid) && !_checkDmBotAntiLoop(remoteJid)) {
        console.log(`🛑 Anti-loop: silenciando DM de bot conhecido ${remoteJid} (limite de turnos atingido)`);
        continue;
      }

      // Check azul imediato — força tipo 'read' independente de privacySettings
      try {
        const jid = msg.key.remoteJid;
        const participant = msg.key.participant || undefined;
        await sock.sendReceipt(jid, participant, [msg.key.id], 'read');
      } catch (_) {}

      // Entrada: em grupo o label carrega o JID do grupo E o participante. Sem o
      // grupo, toda mensagem recebida virava `grupo:<lid>` e não dava pra filtrar
      // o log por conversa (só a saída do bot tinha o JID do grupo).
      const role = isGroup
        ? `grupo:${remoteJid}/${msg.key.participant || remoteJid}`
        : _jidToRole(remoteJid);
      // Saída endereça a CONVERSA (grupo ou DM), nunca o participante.
      const botRole = _jidToRole(remoteJid);

      // Detecta citação (usuário respondeu a uma mensagem específica).
      // Mídia citada (áudio/vídeo) é baixada e transcrita aqui dentro.
      const quotedCtx = await _extractQuotedContext(msg);
      if (quotedCtx?.quotedText) {
        console.log(`💬 Citação detectada: ${quotedCtx.quotedParticipant} → "${quotedCtx.quotedText.slice(0, 80)}"`);
        _appendConv(`[citação de ${quotedCtx.quotedParticipant}]`, quotedCtx.quotedText);
      }

      // Detecta tipo de conteúdo: texto direto OU áudio (PTT/voice note)
      let text = _extractText(msg);
      let prompt = text;
      const audioMsg = msg.message?.audioMessage;

      // Mídia recebida (imagem/vídeo/áudio/figurinha/documento) → persiste em
      // disco. Sem caption, registra no log (com caption, a caption já é
      // logada como texto adiante; áudio é logado pela transcrição).
      const savedMedia = await _saveInboundMedia(msg, role);
      if (savedMedia && !text && savedMedia.kind !== 'audioMessage') {
        const rotulo = { imageMessage: 'imagem', videoMessage: 'vídeo',
          stickerMessage: 'figurinha', documentMessage: 'documento' }[savedMedia.kind] || 'mídia';
        _appendConv(role, `[${rotulo} recebido: ${path.basename(savedMedia.path)}]`);
      }

      // ── Hard block de mensagens vazias / só caractere invisível ──
      // Lição operacional 2026-06-05: Diego mandou caractere invisível (U+2063)
      // em rajada e o René respondeu cada um com áudio TTS "fico em silêncio
      // conforme regra anti-loop" — meta-narração do silêncio que vira loop.
      // Bloqueio no código pra não depender do prompt seguir a regra.
      const cleanText = String(text || '').replace(/[​-‍⁠-⁤﻿ \s]/g, '');
      const hasUsefulMedia = savedMedia && ['audioMessage', 'videoMessage', 'imageMessage', 'documentMessage'].includes(savedMedia.kind);
      const hasQuoted = !!quotedCtx?.quotedText;
      if (!cleanText && !hasUsefulMedia && !hasQuoted) {
        const _sender = msg.key.participant || remoteJid;
        console.log(`🤫 Msg vazia/invisível ignorada (de ${_sender}) — sem criação de task`);
        continue;
      }

      // Vídeo recebido → extrai frames + transcreve áudio → injeta contexto
      if (savedMedia?.kind === 'videoMessage' && savedMedia.path) {
        const videoDur = msg.message?.videoMessage?.seconds || 30;
        console.log(`🎬 WhatsApp ← ${remoteJid}: vídeo ${videoDur}s, processando…`);
        try {
          const videoAnalysis = await _processVideo(savedMedia.path, videoDur);
          if (videoAnalysis) {
            const videoCtx = `[vídeo ${videoDur}s]\n${videoAnalysis}`;
            if (prompt) {
              prompt += `\n\n${videoCtx}`;
            } else {
              prompt = videoCtx;
            }
            text = text || videoCtx;
          }
        } catch (e) {
          console.warn(`⚠️ Processamento de vídeo falhou: ${e.message}`);
        }
      }

      // Imagem recebida → descreve via Vision API e injeta contexto
      if (savedMedia?.kind === 'imageMessage' && savedMedia.path) {
        console.log(`🖼️ WhatsApp ← ${remoteJid}: imagem recebida, descrevendo via Vision…`);
        try {
          const imgBuf = await fs.readFile(savedMedia.path);
          const base64 = imgBuf.toString('base64');
          const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
          if (anthropicKey) {
            const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
            const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': anthropicKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model,
                max_tokens: 400,
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
                    { type: 'text', text: L.imageDescribePrompt }
                  ]
                }]
              })
            });
            if (visionRes.ok) {
              const visionData = await visionRes.json();
              const desc = visionData.content?.[0]?.text;
              if (desc) {
                const imgCtx = `[imagem recebida]\nDescrição: ${desc}`;
                if (prompt) {
                  prompt += `\n\n${imgCtx}`;
                } else {
                  prompt = imgCtx;
                }
                text = text || imgCtx;
                console.log(`🖼️ Imagem descrita: "${desc.slice(0, 100)}…"`);
              }
            } else {
              console.warn(`⚠️ Vision API imagem: ${visionRes.status}`);
            }
          }
        } catch (e) {
          console.warn(`⚠️ Processamento de imagem falhou: ${e.message}`);
        }
      }

      // Documento recebido (PDF, etc.) → extrai texto e injeta contexto
      if (savedMedia?.kind === 'documentMessage' && savedMedia.path) {
        const fileName = msg.message?.documentMessage?.fileName || path.basename(savedMedia.path);
        console.log(`📄 WhatsApp ← ${remoteJid}: documento "${fileName}", processando…`);
        try {
          const ext = path.extname(fileName).toLowerCase();
          if (ext === '.pdf') {
            const pdfBuffer = await fs.readFile(savedMedia.path);
            const parsed = await pdfParse(pdfBuffer);
            const pdfText = (parsed.text || '').trim();
            if (pdfText) {
              const truncated = pdfText.length > 8000 ? pdfText.slice(0, 8000) + '\n[…truncado]' : pdfText;
              const docCtx = `[documento PDF: "${fileName}", ${parsed.numpages} páginas]\n${truncated}`;
              if (prompt) {
                prompt += `\n\n${docCtx}`;
              } else {
                prompt = docCtx;
              }
              text = text || docCtx;
              console.log(`📄 PDF extraído: ${parsed.numpages} págs, ${pdfText.length} chars`);
            } else {
              const docCtx = `[documento PDF: "${fileName}" — sem texto extraível (possivelmente escaneado/imagem)]`;
              if (prompt) {
                prompt += `\n\n${docCtx}`;
              } else {
                prompt = docCtx;
              }
              text = text || docCtx;
              console.log(`📄 PDF sem texto extraível (escaneado?): ${fileName}`);
            }
          } else if (ext === '.csv') {
            // CSV recebido — verificar se é CSV do Regularize pra pipeline @divida
            const csvText = await fs.readFile(savedMedia.path, 'utf-8');
            const dividaPipeline = require('../../src/pipelines/divida-ativa');
            // Tentar detectar CNPJ no preambulo do CSV
            const cnpjMatch = csvText.match(/CPF\/CNPJ:\s*(\d[\d.\/\-]+)/i);
            if (cnpjMatch) {
              const cnpjFound = cnpjMatch[1];
              const pendingCase = await dividaPipeline.getCase(cnpjFound);
              if (pendingCase && pendingCase.status === 'aguardando_csv') {
                console.log(`📊 CSV do Regularize detectado para caso ${pendingCase.id}, processando pipeline...`);
                try {
                  const result = await dividaPipeline.processarCsv(cnpjFound, csvText);
                  const docCtx = `[CSV do Regularize processado — pipeline @divida completo]\n\n${result.resumo}`;
                  prompt = docCtx;
                  text = docCtx;
                  console.log(`✅ Pipeline @divida concluído: ${pendingCase.id}`);
                } catch (pipeErr) {
                  const docCtx = `[CSV do Regularize — erro no pipeline: ${pipeErr.message}]\n\nCSV recebido mas falhou no processamento. Erro: ${pipeErr.message}`;
                  prompt = docCtx;
                  text = docCtx;
                  console.warn(`❌ Pipeline @divida falhou: ${pipeErr.message}`);
                }
              } else {
                const docCtx = `[documento CSV recebido: "${fileName}"]\n${csvText.length > 4000 ? csvText.slice(0, 4000) + '\n[…truncado]' : csvText}`;
                if (!prompt) { prompt = docCtx; text = docCtx; }
                else { prompt += `\n\n${docCtx}`; }
              }
            } else {
              const docCtx = `[documento CSV recebido: "${fileName}"]\n${csvText.length > 4000 ? csvText.slice(0, 4000) + '\n[…truncado]' : csvText}`;
              if (!prompt) { prompt = docCtx; text = docCtx; }
              else { prompt += `\n\n${docCtx}`; }
            }
          } else {
            // Documento não-PDF/não-CSV: só sinaliza que foi recebido
            const docCtx = `[documento recebido: "${fileName}" (${ext || 'sem extensão'})]`;
            if (!prompt) {
              prompt = docCtx;
              text = docCtx;
            }
          }
        } catch (e) {
          console.warn(`⚠️ Processamento de documento falhou: ${e.message}`);
        }
      }

      if (audioMsg) {
        const dur = audioMsg.seconds || 0;
        console.log(`🎤 WhatsApp ← ${remoteJid}: áudio ${dur}s, transcrevendo…`);
        try {
          const transcription = preAudioTranscript || await _transcribeAudio(msg);
          if (!transcription) {
            console.warn(`⚠️ áudio vazio após ${strategies?.length || 3} tentativas de transcrição`);
            if (!text) {
              const errMsg = 'Não consegui transcrever esse áudio — pode ter ficado muito curto ou sem fala clara. Se quiser, manda em texto.';
              try {
                if (TTS_MODE === 'audio_only' && TTS_ENABLED) {
                  await _sendAsAudio(remoteJid, errMsg);
                } else {
                  await sock.sendMessage(remoteJid, { text: errMsg });
                }
              } catch (e) {}
              continue;
            }
            // Tinha texto junto — segue com o texto, áudio não transcreveu
          } else if (text) {
            // Texto + áudio: combina os dois
            text = `${text}\n[áudio ${dur}s] ${transcription}`;
            prompt = `${prompt}\n\n[áudio transcrito]: ${transcription}`;
          } else {
            text = `[áudio ${dur}s] ${transcription}`;
            // Marca que veio de áudio transcrito — senão o Claude acha que recebeu
            // texto e responde errado a "você recebe meu áudio?".
            prompt = `[áudio transcrito]: ${transcription}`;
          }
        } catch (e) {
          console.error(`❌ transcrição falhou:`, e.message);
          const errMsg = '⚠️ Tive um problema técnico processando o áudio. Tô resolvendo aqui.';
          try {
            if (TTS_MODE === 'audio_only' && TTS_ENABLED) {
              await _sendAsAudio(remoteJid, errMsg);
            } else {
              await sock.sendMessage(remoteJid, { text: errMsg });
            }
          } catch (_) {}
          continue;
        }
      }

      if (!text) continue;
      console.log(`📩 WhatsApp ← ${remoteJid}: ${text.slice(0, 80)}`);
      _appendConv(role, text);

      // Memory shortcuts — não dispara Claude, grava direto e responde
      const memShortcut = _memoryShortcut(text);
      if (memShortcut) {
        try {
          const reply = await memShortcut();
          await sock.sendMessage(remoteJid, { text: reply });
          _appendConv(`bot→${botRole}`, reply);
          console.log(`💾 mem shortcut → ${botRole}: ${reply}`);
        } catch (e) {
          await sock.sendMessage(remoteJid, { text: `❌ falhou: ${e.message}` });
        }
        continue;
      }

      // Plano Claude desconectado — mensagem não vira task (queimaria retries
      // com 401). Responde com o lembrete rate-limited e para aqui. Os memory
      // shortcuts acima seguem funcionando (não dependem do Claude).
      if (authMonitor.isDown()) {
        await _notifyAuthDown(remoteJid);
        continue;
      }

      // Session anchor pra mirror cross-channel (Hermes-style origin tracking).
      const sessionAnchor = `wa:${remoteJid}`;

      // Hydra contexto multi-turno: injeta últimas mensagens da mesma conversa.
      const historyCtx = convHistory.getFormattedHistory('wa', remoteJid, 4);

      // Citação: se usuário respondeu a uma mensagem específica, inclui no contexto.
      // Reutiliza quotedCtx já resolvido acima (não re-baixa nem re-transcreve).
      let quotedContext = '';
      if (quotedCtx?.quotedText) {
        const sender = quotedCtx.quotedParticipant;
        quotedContext = `\n[Você está respondendo à mensagem de ${sender}: "${quotedCtx.quotedText.slice(0, 200)}"]`;
      }

      // Monta prompt final: quem fala + citação + contexto histórico + mensagem.
      // O memory-context (SOUL/USER/MEMORY) é injetado pelo task-runner.
      //
      // [FASE 3] Identidade resolvida em 2 etapas (LID→número via Baileys, número→pessoa
      // via contacts.json). Substituiu o _jidToName(remoteJid) hardcoded, que tinha bug
      // duplo: misturava LID+número na mesma lista, e em grupo passava remoteJid (JID do
      // grupo @g.us) em vez do participant — sempre retornava null.
      const senderJid = msg.key.participant || remoteJid;
      let identity;
      try {
        identity = await resolveIdentity({ jid: senderJid, sock, msg });
      } catch (e) {
        console.error('[identity-resolver] falhou:', e.message);
        identity = { phone: null, lid: null, name: 'Desconhecido', name_source: 'unknown', person_id: null };
      }

      const interlocutor = identity.name_source !== 'unknown' ? identity.name : null;
      // A identidade fica ADJACENTE à mensagem atual (depois do histórico), não no
      // topo do prompt: com histórico longo o modelo ancorava nos nomes citados nas
      // últimas mensagens e respondia à pessoa errada (chamou Diego de Bianca,
      // Bianca de Vagner — 2026-07-16). Posição + aviso explícito sobre nomes do
      // histórico resolvem a ancoragem.
      const quemFala = interlocutor
        ? `[A mensagem atual é de ${interlocutor} — dirija a resposta a ${interlocutor}. Nomes que aparecem no histórico acima são outras pessoas mencionadas na conversa, não necessariamente quem fala agora.]\n`
        : '';
      const finalPrompt = `${quotedContext}${historyCtx ? '\n' + historyCtx : ''}\n${quemFala}Mensagem atual: ${prompt}`;

      // Intent classification: detecta se é ação (executar) ou conversa (responder).
      const classification = classifyIntent(prompt);
      const isAction = classification.intent === 'action';
      console.log(`🎯 intent: ${classification.intent} (${(classification.confidence * 100).toFixed(0)}%) — ${classification.reason} — ${prompt.slice(0, 60)}`);

      // Ação → maxTurns maior + system prompt de execução silenciosa
      const baseSystemPrompt = TTS_ENABLED ? TTS_SYSTEM_PROMPT : undefined;

      // ── Filtro de tópico por grupo (projectName no whatsapp-groups.json) ──
      // Quando o grupo tem projectName definido, injeta instrução pra manter foco.
      let groupTopicAddendum = '';
      if (isGroup) {
        const groupMeta = observedGroups.get(remoteJid);
        if (groupMeta?.projectName) {
          groupTopicAddendum = `\n\nEste grupo é EXCLUSIVO para assuntos de ${groupMeta.projectName}. Se a mensagem tratar de outro assunto, responda brevemente redirecionando: "Esse assunto foge do escopo deste grupo (${groupMeta.projectName}). Manda no privado ou no grupo certo que eu resolvo lá."`;
        }
      }

      const effectiveSystemPrompt = isAction && baseSystemPrompt
        ? `${baseSystemPrompt}${groupTopicAddendum}\n\n${ACTION_SYSTEM_ADDENDUM}`
        : isAction
          ? `${ACTION_SYSTEM_ADDENDUM}${groupTopicAddendum}`
          : baseSystemPrompt
            ? `${baseSystemPrompt}${groupTopicAddendum}`
            : groupTopicAddendum || undefined;
      const effectiveMaxTurns = isAction ? 50 : 25;

      try {
        const me = sock.authState?.creds?.me || sock.user;
        console.log(`🔍 typing debug: remoteJid=${remoteJid} me.id=${me?.id} me.lid=${me?.lid} me.name=${me?.name}`);
        await sock.sendPresenceUpdate('available');
        await sock.presenceSubscribe(remoteJid);
        await sock.sendPresenceUpdate('composing', remoteJid);
        console.log(`✅ typing indicator enviado para ${remoteJid}`);
      } catch (e) {
        console.warn(`⚠️ typing indicator falhou: ${e.message}`);
      }

      // Serialização FIFO por jid: aguarda a Promise da resposta anterior
      // desse user terminar ANTES de criar a próxima task. Garante ordem das
      // respostas mesmo se o user mandar 2 áudios seguidos.
      const prevInflight = inflightByJid.get(remoteJid) || Promise.resolve();
      let resolveInflight;
      const thisInflight = new Promise((r) => { resolveInflight = r; });
      inflightByJid.set(remoteJid, thisInflight);

      // Typing inicia imediatamente — fica aceso durante a espera + processamento.
      const typingInterval = setInterval(() => {
        sock.sendPresenceUpdate('available')
          .then(() => sock.sendPresenceUpdate('composing', remoteJid))
          .catch((e) => {
            console.warn(`⚠️ typing keepalive falhou: ${e.message}`);
          });
      }, 5000);

      // Aguarda anterior (não trava o handler do upsert porque o for-await já é async)
      await prevInflight.catch(() => {}); // erros da anterior não derrubam essa

      // senderId: número canônico (apenas dígitos) — bate com WHATSAPP_ADMIN_NUMBERS
      // pra resolver role na config/tool-policies.js. Em grupos, usa participant
      // (quem mandou de fato) e não o remoteJid (o grupo).
      const _senderJidForPolicy = isGroup
        ? (msg.key.participant || '').split('@')[0]
        : remoteJid.split('@')[0];
      const _senderIdForPolicy = _normalizeNumber(_senderJidForPolicy);

      const task = taskRunner.createTask({
        prompt: finalPrompt,
        source: 'whatsapp',
        systemPrompt: effectiveSystemPrompt,
        peer: identity.person_id || (interlocutor ? interlocutor.toLowerCase() : null),
        senderId: _senderIdForPolicy,
        tags: ['whatsapp', `from:${remoteJid}`, `session:${sessionAnchor}`, audioMsg ? 'audio' : 'text', isAction ? 'intent:action' : 'intent:convo'],
        maxTurns: effectiveMaxTurns,
      });

      pendingByTaskId.set(task.id, {
        remoteJid,
        startedAt: Date.now(),
        typingInterval,
        resolveInflight,
        thisInflight,
        // Mensagem CRUA do interlocutor (sem wrapper de injeção). É o que vai
        // pro convHistory — persistir finalPrompt causava aninhamento matryoshka
        // do wrapper a cada turno (bug estrutural, fix 2026-07-02).
        rawMessage: prompt,
        // Em grupo, o histórico precisa distinguir os falantes: sem isso todo
        // mundo vira "[Usuário]" e o modelo confunde interlocutor com mencionado.
        senderName: isGroup ? interlocutor : null,
      });
    }
  });

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
    if (!isReady || pendingByTaskId.size === 0) return;

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

  return sock;
}

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

// ── Transcrição de mídia citada ──

// Baixa mídia citada usando downloadMediaMessage (reutiliza session auth do sock).
async function _downloadQuotedMedia(quotedMsg) {
  if (!sock) return null;
  try {
    const buffer = await downloadMediaMessage({ message: quotedMsg }, 'buffer', {}, { logger });
    return buffer;
  } catch (e) {
    console.warn(`⚠️ download mídia citada falhou: ${e.message}`);
    return null;
  }
}

// Descreve imagem citada usando Vision API do Claude.
// Retorna null se não for imagem ou se falhar.
async function _describeQuotedImage(quotedMsg) {
  if (!quotedMsg?.imageMessage) return null;
  try {
    const buffer = await _downloadQuotedMedia(quotedMsg);
    if (!buffer) return null;

    const base64 = buffer.toString('base64');
    const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.warn('⚠️ Vision: sem ANTHROPIC_AUTH_TOKEN');
      return null;
    }

    const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: L.imageDescribeShortPrompt },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }
          ]
        }]
      })
    });

    if (!res.ok) {
      console.warn(`⚠️ Vision API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.content?.[0]?.text || null;
  } catch (e) {
    console.warn(`⚠️ Vision description failed: ${e.message}`);
    return null;
  }
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

// Extrai e transcreve mídia citada (áudio, vídeo ou imagem).
// Retorna null se não for mídia ou se falhar.
async function _transcribeQuotedMedia(contextInfo) {
  const quotedMsg = contextInfo?.quotedMessage;
  if (!quotedMsg) return null;

  const mediaType = _quotedMediaType(quotedMsg);
  if (!mediaType) return null;

  // Imagem → Vision API
  if (mediaType === 'image') {
    const description = await _describeQuotedImage(quotedMsg);
    return description ? `[imagem: ${description}]` : null;
  }

  // Documento citado (PDF, etc.) → baixa e extrai texto
  if (mediaType === 'document') {
    try {
      const buffer = await _downloadQuotedMedia(quotedMsg);
      if (!buffer) return null;
      const fileName = quotedMsg.documentMessage?.fileName || 'documento';
      const ext = path.extname(fileName).toLowerCase();
      if (ext === '.pdf') {
        const parsed = await pdfParse(buffer);
        const pdfText = (parsed.text || '').trim();
        if (pdfText) {
          const truncated = pdfText.length > 8000 ? pdfText.slice(0, 8000) + '\n[…truncado]' : pdfText;
          return `[documento PDF citado: "${fileName}", ${parsed.numpages} páginas]\n${truncated}`;
        }
        return `[documento PDF citado: "${fileName}" — sem texto extraível (possivelmente escaneado)]`;
      }
      return `[documento citado: "${fileName}" (${ext || 'sem extensão'})]`;
    } catch (e) {
      console.warn(`⚠️ Processamento de documento citado falhou: ${e.message}`);
      return null;
    }
  }

  const ts = Date.now();
  const oggPath = `/tmp/wa-quoted-${ts}.ogg`;
  const txtPrefix = `/tmp/wa-quoted-${ts}`;
  const txtPath = `${txtPrefix}.txt`;

  try {
    const buffer = await _downloadQuotedMedia(quotedMsg);
    if (!buffer) return null;
    await fs.writeFile(oggPath, buffer);

    // Se vídeo, extrai só o áudio primeiro.
    let audioPath = oggPath;
    let isVideo = false;
    if (mediaType === 'video') {
      audioPath = `/tmp/wa-quoted-${ts}-video.wav`;
      await _runCmd(FFMPEG_BIN, ['-y', '-i', oggPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audioPath], 'ffmpeg');
      isVideo = true;
    }

    // Transcrição com fallback 3x (mesmas estratégias de _transcribeAudio).
    const strategies = [
      { ar: '16000', ac: '1', whisperExtra: [] },
      { ar: '16000', ac: '1', whisperExtra: ['-bs', '5', '-bo', '5'] },
      { ar: '8000',  ac: '1', whisperExtra: [] },
    ];

    let text = null;
    let lastErr = null;

    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      const wavPath = `/tmp/wa-quoted-${ts}-attempt${i}.wav`;
      try {
        await _runCmd(FFMPEG_BIN, ['-y', '-i', audioPath, '-ar', s.ar, '-ac', s.ac, '-c:a', 'pcm_s16le', wavPath], 'ffmpeg');
        await _runCmd(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wavPath, '-l', WHISPER_LANG, '-otxt', '-of', txtPrefix, '-nt', ...s.whisperExtra], 'whisper');
        const t = (await fs.readFile(txtPath, 'utf8')).trim();
        if (t) { text = t; break; }
      } catch (e) {
        lastErr = e;
      } finally {
        fs.unlink(wavPath).catch(() => {});
        fs.unlink(txtPath).catch(() => {});
      }
    }

    fs.unlink(oggPath).catch(() => {});
    if (isVideo) fs.unlink(audioPath).catch(() => {});

    if (text) {
      const label = mediaType === 'video' ? 'vídeo' : 'áudio';
      console.log(`💬 Citação transcrita (${label}): ${text.slice(0, 80)}`);
      return text;
    }

    if (lastErr) console.warn(`⚠️ transcrição mídia citada falhou: ${lastErr.message}`);
    return null;

  } catch (e) {
    console.warn(`⚠️ _transcribeQuotedMedia erro: ${e.message}`);
    return null;
  }
}

// ── Extração de citação (quoted message) ──
// Baileys expone contextInfo.stanzaId / contextInfo.participant / contextInfo.remoteJid
// quando o user responde a uma mensagem específica no WhatsApp.
async function _extractQuotedContext(msg) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo
                   || msg.message?.imageMessage?.contextInfo
                   || msg.message?.videoMessage?.contextInfo
                   || msg.message?.audioMessage?.contextInfo
                   || msg.message?.documentMessage?.contextInfo;
  if (!contextInfo) return null;

  // stanzaId é o ID da mensagem citada (protocol namespace: adwa)
  const quotedId = contextInfo.stanzaId || null;
  // participant é o JID de quem enviou a mensagem citada
  const quotedParticipant = contextInfo.participant
    ? String(contextInfo.participant).split('@')[0].replace(/\D/g, '')
    : null;

  const quotedMsg = contextInfo.quotedMessage;
  // Texto direto da mensagem citada (conversa, texto estendido ou caption).
  let quotedText = quotedMsg
    ? (
        quotedMsg.conversation ||
        quotedMsg.extendedTextMessage?.text ||
        quotedMsg.imageMessage?.caption ||
        quotedMsg.videoMessage?.caption ||
        quotedMsg.documentMessage?.caption ||
        ''
      ).trim()
    : '';

  // Mídia citada sem texto (áudio/vídeo): baixa e transcreve pra dar ao agente
  // o conteúdo real da mensagem referenciada. Pode levar alguns segundos.
  if (!quotedText && _quotedMediaType(quotedMsg)) {
    const transcription = await _transcribeQuotedMedia(contextInfo);
    quotedText = transcription || '[mídia citada indisponível]';
  }

  if (!quotedId && !quotedText) return null;

  const label = quotedParticipant
    ? (quotedParticipant.startsWith('+') ? quotedParticipant : `+${quotedParticipant}`)
    : 'msg citada';
  return { quotedId, quotedParticipant: label, quotedText: quotedText || '[mensagem citada]' };
}

// ── API externa: enviar mensagens diretas (pra rota POST /api/whatsapp/say) ──
async function sendText(jid, text) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  text = _stripLinkFormatting(text);
  await sock.sendMessage(jid, { text });
  _appendConv(`bot→${_jidToRole(jid)}`, text);
}

async function sendVoice(jid, text) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  if (!TTS_ENABLED) throw new Error('TTS não habilitado (ELEVENLABS_API_KEY ausente)');
  const mp3 = await _synthesizeTTS(text);
  const ogg = await _mp3ToOggOpus(mp3);
  await sock.sendMessage(jid, {
    audio: ogg,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  });
  _appendConv(`bot→${_jidToRole(jid)}`, `[áudio TTS direto] ${text.slice(0, 120)}`);
}

// Envia um vídeo (Buffer MP4) como mídia no WhatsApp, com legenda opcional.
async function sendVideo(jid, videoBuffer, caption) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  if (!Buffer.isBuffer(videoBuffer)) throw new Error('sendVideo exige um Buffer de vídeo');
  await sock.sendMessage(jid, {
    video: videoBuffer,
    mimetype: 'video/mp4',
    caption: caption || undefined,
  });
  _appendConv(`bot→${_jidToRole(jid)}`, `[vídeo]${caption ? ' ' + caption.slice(0, 80) : ''}`);
}

async function sendDocument(jid, docBuffer, filename, mimetype, caption) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  if (!Buffer.isBuffer(docBuffer)) throw new Error('sendDocument exige um Buffer');
  await sock.sendMessage(jid, {
    document: docBuffer,
    mimetype: mimetype || 'application/octet-stream',
    fileName: filename || 'document',
    caption: caption || undefined,
  });
  _appendConv(`bot→${_jidToRole(jid)}`, `[documento] ${filename || 'doc'}${caption ? ' — ' + caption.slice(0, 60) : ''}`);
}

// Retorna o caminho da imagem recebida mais recente (varre o disco, então
// sobrevive a restart do backend). null se não houver nenhuma.
async function getLatestInboundImage() {
  try {
    await fs.ensureDir(INBOUND_MEDIA_DIR);
    const files = (await fs.readdir(INBOUND_MEDIA_DIR))
      .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
      .map(f => {
        const p = path.join(INBOUND_MEDIA_DIR, f);
        return { p, t: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].p : null;
  } catch {
    return null;
  }
}

// Atualiza a foto de perfil DO PRÓPRIO bot no WhatsApp.
// Baileys (sharp) recorta/redimensiona a imagem internamente.
async function setProfilePhoto(imagePathOrBuffer) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  const selfJid = sock.user?.id;
  if (!selfJid) throw new Error('JID do próprio bot indisponível');
  const buffer = Buffer.isBuffer(imagePathOrBuffer)
    ? imagePathOrBuffer
    : await fs.readFile(imagePathOrBuffer);
  await sock.updateProfilePicture(jidNormalizedUser(selfJid), buffer);
  _appendConv('config', `[foto de perfil do bot atualizada — ${buffer.length} bytes]`);
  return { ok: true, jid: jidNormalizedUser(selfJid), bytes: buffer.length };
}

// Cria um grupo WhatsApp e retorna metadata (id, subject, participants).
async function createGroup(subject, participantJids = [], { open = true } = {}) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  const meta = await sock.groupCreate(subject, participantJids);
  _appendConv('config', `[grupo criado: "${subject}" — ${meta.id}]`);
  // Já registra como observado + aberto em runtime, pra responder a todos os
  // membros de primeira — sem editar código nem reiniciar.
  if (meta?.id) addObservedGroup(meta.id, subject, { open });
  return meta;
}

// Retorna metadata do grupo + tenta resolver cada participante `@lid` em telefone
// via `signalRepository.lidMapping.getPNForLID` (USync no servidor do WhatsApp).
async function getGroupInfo(jid) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  const meta = await sock.groupMetadata(jid);
  const lidMapping = sock.signalRepository?.lidMapping;
  const participants = [];
  for (const p of meta.participants || []) {
    const entry = { id: p.id, admin: p.admin || null };
    if (p.id?.endsWith('@lid') && lidMapping?.getPNForLID) {
      try {
        const pn = await lidMapping.getPNForLID(p.id);
        if (pn) entry.phone = pn;
      } catch (e) {
        entry.resolveError = e.message;
      }
    }
    participants.push(entry);
  }
  return { id: meta.id, subject: meta.subject, size: meta.size, participants };
}

// Resolve um telefone em JID/LID: consulta o WhatsApp (onWhatsApp) e o
// mapeamento local LID↔PN. Permite cruzar um número com participantes de
// grupo, que hoje chegam quase sempre como `@lid`.
async function resolvePhone(phone) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  const digits = String(phone).replace(/\D/g, '');
  const out = { phone: digits, exists: null, jid: null, lid: null };
  try {
    const res = await sock.onWhatsApp(digits);
    if (res && res[0]) {
      out.exists = !!res[0].exists;
      out.jid = res[0].jid || null;
      out.lid = res[0].lid || null;
    }
  } catch (e) {
    out.onWhatsAppError = e.message;
  }
  const lidMapping = sock.signalRepository?.lidMapping;
  if (!out.lid && lidMapping?.getLIDForPN) {
    try {
      const lid = await lidMapping.getLIDForPN(`${digits}@s.whatsapp.net`);
      if (lid) out.lid = lid;
    } catch (e) {
      out.lidMappingError = e.message;
    }
  }
  return out;
}

// Atualiza o nome de perfil do próprio bot no WhatsApp.
async function setProfileName(newName) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  await sock.updateProfileName(newName);
  _appendConv('config', `[nome do perfil alterado para "${newName}"]`);
  return { ok: true, name: newName };
}

// Retorna o link de convite (chat.whatsapp.com/<code>) do grupo. Exige que o
// bot seja admin do grupo. Usado quando addParticipants falha por
// account_reachout_restricted — o usuário entra pelo link.
async function getGroupInviteLink(jid) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  const code = await sock.groupInviteCode(jid);
  return { jid, code, url: `https://chat.whatsapp.com/${code}` };
}

// Renomeia um grupo (groupUpdateSubject do Baileys). O bot precisa ser admin.
async function setGroupSubject(jid, subject) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  await sock.groupUpdateSubject(jid, subject);
  _appendConv('config', `[grupo ${jid} renomeado para "${subject}"]`);
  return { ok: true, jid, subject };
}

// Atualiza a descrição de um grupo. O bot precisa ser admin.
async function setGroupDescription(jid, description) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  await sock.groupUpdateDescription(jid, description);
  _appendConv('config', `[grupo ${jid} descrição atualizada]`);
  return { ok: true, jid };
}

// Adiciona/remove/promove/demote participantes. action ∈ add|remove|promote|demote.
async function updateGroupParticipants(jid, participantJids, action) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
    throw new Error(`action inválida: ${action} (use add|remove|promote|demote)`);
  }
  const result = await sock.groupParticipantsUpdate(jid, participantJids, action);
  _appendConv('config', `[grupo ${jid} ${action}: ${participantJids.join(',')}]`);
  return { ok: true, jid, action, result };
}

// Entra num grupo via invite code (parte final do link chat.whatsapp.com/<code>).
async function acceptGroupInvite(inviteCode) {
  if (!sock || !isReady) throw new Error('canal WhatsApp ainda não conectado');
  const groupId = await sock.groupAcceptInvite(inviteCode);
  _appendConv('config', `[entrou no grupo ${groupId} via invite code ${inviteCode}]`);
  return { ok: true, groupId, inviteCode };
}

async function listGroups() {
  if (!sock || !isReady) throw new Error('WhatsApp não conectado');
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map(g => ({
    id: g.id,
    subject: g.subject,
    participants: g.participants?.length || 0,
    admins: (g.participants || []).filter(p => p.admin).length,
  }));
}

module.exports = {
  start, sendText, sendVoice, sendVideo, sendDocument,
  setProfilePhoto, setProfileName, getLatestInboundImage,
  createGroup, getGroupInfo, getGroupInviteLink, setGroupSubject, setGroupDescription, updateGroupParticipants,
  resolvePhone,
  acceptGroupInvite, listGroups,
  addDmAllowed, removeDmAllowed, listDmAllowed,
  addObservedGroup, removeObservedGroup, isGroupObserved, listObservedGroups, setGroupOpen,
  _extractCurrentMessage, // exportado pra teste (fix matryoshka 2026-07-02)
};
