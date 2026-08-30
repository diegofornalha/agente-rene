'use strict';
/**
 * services/elevenlabs.js — TTS ElevenLabs standalone (gera MP3 de voz natural).
 *
 * Usado tanto pelo canal WhatsApp (resposta em áudio) quanto pelo pipeline de
 * Reels vertical (services/heygen-reels.js), onde o MP3 da voz natural é
 * enviado ao HeyGen como áudio externo pra lip-sync — em vez do TTS interno
 * do HeyGen, que sai robótico.
 *
 * ⚠️ NÃO usar o parâmetro `speed` pra acelerar quando o áudio for virar vídeo:
 * o time-stretch só no áudio quebra o lip-sync do HeyGen. Acelerar é trabalho
 * do ffmpeg, depois (ver services/video-postprocess.js).
 */

const { prepareTextForTTS: _prepareTextForTTS } = require('./tts-sanitizer');

const _key   = () => process.env.ELEVENLABS_API_KEY || '';
const _voice = () => process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const _model = () => process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

function isEnabled() {
  return !!_key();
}

/**
 * Sintetiza texto em um MP3 com a voz configurada.
 * @param {string} texto
 * @param {object} [opts]
 * @param {string} [opts.voiceId] - sobrescreve ELEVENLABS_VOICE_ID
 * @param {string} [opts.modelId] - sobrescreve ELEVENLABS_MODEL
 * @param {number} [opts.stability=0.5]
 * @param {number} [opts.similarityBoost=0.75]
 * @returns {Promise<Buffer>} buffer MP3 (audio/mpeg)
 */
async function gerarMp3(texto, opts = {}) {
  if (!_key()) throw new Error('ELEVENLABS_API_KEY ausente no .env');
  if (!texto || !String(texto).trim()) throw new Error('gerarMp3 exige texto não-vazio');

  const spoken = opts.skipSanitize ? String(texto) : _prepareTextForTTS(String(texto));
  const voiceId = opts.voiceId || _voice();
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': _key(),
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: spoken,
      model_id: opts.modelId || _model(),
      voice_settings: {
        stability: opts.stability ?? 0.5,
        similarity_boost: opts.similarityBoost ?? 0.75,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { gerarMp3, isEnabled };
