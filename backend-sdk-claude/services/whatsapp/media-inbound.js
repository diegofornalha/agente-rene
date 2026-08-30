'use strict';
// media-inbound.js — mídia RECEBIDA no WhatsApp: persistência em disco,
// transcrição de áudio/vídeo (ffmpeg → whisper-cli), descrição de imagem via
// Vision API, extração de PDF e resolução de mídia/contexto citado.

const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const pino = require('pino');
const pdfParse = require('pdf-parse');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const sockRef = require('./sock-ref');
const { _quotedMediaType } = require('./message-extract');
const L = require('../../config/locale');

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

const logger = pino({ level: 'warn' });

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

// ── Transcrição de mídia citada ──

// Baixa mídia citada usando downloadMediaMessage (reutiliza session auth do sock).
async function _downloadQuotedMedia(quotedMsg) {
  if (!sockRef.getSock()) return null;
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

module.exports = {
  FFMPEG_BIN,
  INBOUND_MEDIA_DIR,
  _runCmd,
  _transcribeAudio,
  _processVideo,
  _saveInboundMedia,
  getLatestInboundImage,
  _downloadQuotedMedia,
  _describeQuotedImage,
  _transcribeQuotedMedia,
  _extractQuotedContext,
};
