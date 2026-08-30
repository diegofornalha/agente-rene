// Canal WhatsApp via Baileys (WhatsApp Web não-oficial).
// Recebe mensagens DM, cria task no taskRunner e responde com o resultado.
//
// Ativar via .env:
//   WHATSAPP_ENABLED=true
//   WHATSAPP_ALLOWED_NUMBERS=+5511999999999,+5511888888888   (opcional; vazio = libera todo mundo)
//   WHATSAPP_AUTH_DIR=./data/whatsapp-auth                   (opcional)

const path = require('path');
const fs = require('fs-extra');
const convHistory = require('../memory/conversation-history');
const { _memoryShortcut } = require('./memory-shortcuts');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const pdfParse = require('pdf-parse');

const metrics = require('../health/metrics');
const authMonitor = require('../health/auth-monitor');
const { isAuthErrorStrict } = authMonitor;
const { classify: classifyIntent, ACTION_SYSTEM_ADDENDUM } = require('../intent-classifier');
const identityStore = require('./identity-store');
const { resolveIdentity } = require('./identity-resolver');

// Strings voltadas ao usuário final (TTS, prompts de mídia, heartbeat) vêm do
// locale — selecionado via AGENT_LOCALE (default pt-BR, ver config/locale/).
const L = require('../../config/locale');

const {
  _runCmd, _transcribeAudio, _processVideo, _saveInboundMedia,
  getLatestInboundImage, _downloadQuotedMedia, _describeQuotedImage,
  _transcribeQuotedMedia, _extractQuotedContext,
} = require('./media-inbound');
const {
  TTS_ENABLED, TTS_MODE, TTS_SYSTEM_PROMPT,
  _synthesizeTTS, _mp3ToOggOpus, _sendAsAudio, _sendStreamingAudio,
} = require('./tts');

const QR_PNG_PATH = process.env.WHATSAPP_QR_PNG || '/tmp/whatsapp-qr.png';
const sockRef = require('./sock-ref');
const { CONV_LOG_PATH, _appendConv, _jidToRole } = require('./conv-log');
const {
  _msgContextInfo, _extractQuotedText, _extractText, _extractLinks,
  _splitDetails, _splitSummaryBody, _quotedMediaType, _stripLinkFormatting,
  _extractCurrentMessage,
} = require('./message-extract');

const {
  OPEN_GROUPS, observedGroups, _loadGroupAllowlist, _loadGroupStore,
  isGroupObserved, addObservedGroup, setGroupOpen, removeObservedGroup,
  listObservedGroups,
} = require('./group-registry');
const {
  _normalizeNumber, _loadDmAllowlist, _isAllowed,
  addDmAllowed, removeDmAllowed, listDmAllowed,
} = require('./dm-allowlist');

const logger = pino({ level: 'warn' });

const {
  _checkGroupAntiLoop, _checkDmBotAntiLoop, _jidIsKnownBot, _isFromKnownBot,
  _normForDedup, _lastReplyByJid, SEMANTIC_DEDUP_WINDOW_MS,
} = require('./anti-loop');
const {
  pendingByTaskId, inflightByJid, _notifyAuthDown, _formatReply,
  _rehydrateZombieTasks, _summarizeStepsViaClaude,
} = require('./reply-delivery');

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







// API pública preservada: consumidores (server.js, health-cron, testes)
// continuam importando tudo deste módulo; os submódulos são detalhe interno.
const outbound = require('./outbound');

module.exports = {
  start,
  ...outbound,
  getLatestInboundImage,
  addDmAllowed, removeDmAllowed, listDmAllowed,
  addObservedGroup, removeObservedGroup, isGroupObserved, listObservedGroups, setGroupOpen,
  _extractCurrentMessage, // exportado pra teste (fix matryoshka 2026-07-02)
};
