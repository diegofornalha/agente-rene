'use strict';
// tts.js — voz do canal WhatsApp: ElevenLabs (mp3) → OGG/Opus (ffmpeg) →
// PTT no WhatsApp. Config e modos de saída (TTS_MODE) vivem aqui.

const { spawn } = require('child_process');
const sockRef = require('./sock-ref');
const { prepareTextForTTS: _prepareTextForTTS } = require('../media/tts-sanitizer');
const { FFMPEG_BIN } = require('./media-inbound');

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

// Envia texto como áudio TTS (usado pra erros/avisos em modo audio_only).
async function _sendAsAudio(remoteJid, text) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) return;
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

// Streaming TTS: envia áudio assim que uma frase completa é detectada.
// Não bloqueia — roda em background. Best-effort.
async function _sendStreamingAudio(remoteJid, phrase) {
  const sock = sockRef.getSock();
  if (!sock || !sockRef.isReady()) return;
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

module.exports = {
  TTS_ENABLED,
  TTS_MODE,
  TTS_SYSTEM_PROMPT,
  _synthesizeTTS,
  _mp3ToOggOpus,
  _sendAsAudio,
  _sendStreamingAudio,
};
