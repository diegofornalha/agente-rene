'use strict';
/**
 * services/heygen-reels.js — pipeline E2E de Reels vertical 9:16.
 *
 *   roteiro
 *     → ElevenLabs TTS (voz natural Clone Lucas)        → MP3
 *     → HeyGen uploadAsset(MP3)                         → audio_asset_id
 *     → HeyGen criarVideo(720×1280, avatarStyle normal) → lip-sync
 *     → poll até completed
 *     → baixarMp4                                       → MP4 vertical cru
 *     → [opcional] ffmpeg acelerar                      → MP4 vertical editado
 *
 * Regras de ouro (bridge-lucrecia, validado E2E em 2026-05-16):
 *   1. Vertical = width 720 / height 1280 + avatarStyle 'normal'.
 *      NUNCA 'closeUp' — enquadra o busto e parece zoom indesejado.
 *   2. Voz via áudio externo (ElevenLabs), não o TTS interno do HeyGen
 *      (que sai robótico).
 *   3. `speed` do ElevenLabs SEMPRE 1.0 — acelerar é trabalho do ffmpeg,
 *      DEPOIS do vídeo pronto (preserva lip-sync). Range Reels: 1.0–1.2.
 *   4. Manter o MP4 <= 100MB (limite do envio WhatsApp). 720p resolve.
 */

const fs = require('fs');
const path = require('path');
const heygen = require('./heygen');
const elevenlabs = require('./elevenlabs');
const { acelerar } = require('./video-postprocess');

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'heygen-videos');
const VERTICAL = { width: 720, height: 1280 }; // 9:16 — NÃO mudar sem testar.

/**
 * Gera um Reels vertical completo a partir de um roteiro.
 * @param {object} opts
 * @param {string} opts.roteiro          - texto que o avatar vai falar (30–2000 chars)
 * @param {number} [opts.speed=1.0]      - aceleração ffmpeg pós-geração (1.0–1.2 p/ Reels)
 * @param {string} [opts.titulo]         - título do vídeo no HeyGen
 * @param {string} [opts.avatarId]       - sobrescreve o avatar default
 * @param {string} [opts.voiceId]        - sobrescreve a voz ElevenLabs
 * @param {function} [opts.onStep]       - callback(step:string) p/ progresso
 * @returns {Promise<{ok,videoId,mp4Path,mp4CruPath,sizeMB,dimension,fator,elapsedMs,log}>}
 */
async function gerarReels(opts = {}) {
  const { roteiro, titulo, avatarId, voiceId } = opts;
  const fator = Number(opts.speed) || 1.0;
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};

  if (!roteiro || !String(roteiro).trim()) throw new Error('gerarReels exige roteiro');
  if (!elevenlabs.isEnabled()) throw new Error('ElevenLabs não configurado (ELEVENLABS_API_KEY)');
  if (!heygen.isEnabled()) throw new Error('HeyGen não configurado (HEYGEN_API_KEY)');

  const log = [];
  const t0 = Date.now();
  const step = (m) => { log.push(m); onStep(m); };

  // 1. ElevenLabs TTS → MP3 (voz natural, speed 1.0)
  step('TTS ElevenLabs…');
  const mp3 = await elevenlabs.gerarMp3(roteiro, { voiceId });
  step(`TTS pronto: ${(mp3.length / 1024).toFixed(0)} KB`);

  // 2. uploadAsset → audio_asset_id
  step('uploadAsset HeyGen…');
  const asset = await heygen.uploadAsset(mp3, 'audio/mpeg');
  const audioAssetId = asset.id || asset.asset_id || asset.image_key;
  if (!audioAssetId) throw new Error(`uploadAsset não devolveu id: ${JSON.stringify(asset)}`);
  step(`asset: ${audioAssetId}`);

  // 3. criarVideo vertical (720×1280, avatarStyle normal, áudio externo)
  step('criarVideo 720×1280…');
  const created = await heygen.criarVideo({
    avatarId,
    audioAssetId,
    avatarStyle: 'normal',
    dimension: VERTICAL,
    title: titulo || `Reels ${new Date().toISOString().slice(0, 10)}`,
  });
  const videoId = created.video_id || created.videoId;
  if (!videoId) throw new Error(`criarVideo não devolveu video_id: ${JSON.stringify(created)}`);
  step(`video_id: ${videoId}`);

  // 4. poll até completed
  step('aguardando renderização…');
  const st = await heygen.aguardarConclusao(videoId);
  if (!st.video_url) throw new Error('vídeo concluído sem video_url');
  step('vídeo renderizado');

  // 5. baixar MP4 cru
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cruPath = path.join(OUT_DIR, `${videoId}-reels.mp4`);
  await heygen.baixarMp4(st.video_url, cruPath);
  step(`MP4 cru baixado: ${cruPath}`);

  // 6. pós-edição opcional (acelerar via ffmpeg — preserva lip-sync)
  let mp4Path = cruPath;
  if (fator !== 1.0) {
    const editPath = path.join(OUT_DIR, `${videoId}-reels-${fator}x.mp4`);
    const r = await acelerar(cruPath, editPath, { fator });
    mp4Path = r.outputPath;
    step(`acelerado ${fator}x → ${r.outputSizeMB} MB`);
  }

  const bytes = fs.statSync(mp4Path).size;
  const sizeMB = +(bytes / 1048576).toFixed(2);
  if (sizeMB > 100) {
    throw new Error(`MP4 ${sizeMB}MB excede o limite de 100MB do envio WhatsApp`);
  }

  return {
    ok: true,
    videoId,
    mp4Path,
    mp4CruPath: cruPath,
    sizeMB,
    dimension: VERTICAL,
    fator,
    elapsedMs: Date.now() - t0,
    log,
  };
}

module.exports = { gerarReels, VERTICAL, OUT_DIR };
