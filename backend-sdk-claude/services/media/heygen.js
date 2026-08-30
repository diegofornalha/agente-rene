'use strict';
/**
 * services/heygen.js — Integração com a API do HeyGen.
 *
 * Portado do bridge comprovado do projeto bridge-lucrecia (heygen-bridge.js,
 * testado E2E em 2026-05-16). Usa a API v2/v1 do HeyGen.
 *
 * Autenticação (a grafia do header difere de propósito entre os domínios):
 *   - api.heygen.com    → header "X-Api-Key"
 *   - upload.heygen.com → header "X-API-KEY"
 *
 * criarVideo() é assíncrono: retorna { video_id }; use aguardarConclusao()
 * para pollar até o vídeo ficar pronto e então baixarMp4() do video_url.
 *
 * Doc: https://docs.heygen.com/reference
 */

const fs = require('fs');
const path = require('path');

const API_BASE    = process.env.HEYGEN_API_BASE   || 'https://api.heygen.com';
const UPLOAD_BASE = process.env.HEYGEN_UPLOAD_BASE || 'https://upload.heygen.com';
const VIDEO_TIMEOUT_MS = Number(process.env.HEYGEN_VIDEO_TIMEOUT_MS || 600000);
const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'heygen-config.json');

function _key() {
  return process.env.HEYGEN_API_KEY || '';
}
function _assertKey() {
  if (!_key()) throw new Error('HEYGEN_API_KEY não configurada no .env');
}
function isEnabled() {
  return !!_key();
}

// Config default (avatar/voz/dimensão). Lê data/heygen-config.json.
function defaultConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      avatarId: '0c7d8978788547528de1856081af37fe',
      voiceId: 'fd8a4d815bd345f38ff5d9e7a47bd0eb',
      dimension: { width: 1280, height: 720 },
      titlePrefix: 'Hermes Mythos —',
    };
  }
}

// Chamada à API REST (api.heygen.com). Normaliza erros (a API às vezes
// devolve HTTP 200 com um campo "error" preenchido).
async function _req(method, pathname, { body, query } = {}) {
  _assertKey();
  let url = `${API_BASE}${pathname}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const opts = { method, headers: { 'X-Api-Key': _key() } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const raw = await res.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
  if (!res.ok || json?.error) {
    const msg = json?.error?.message || json?.error || json?.message || raw.slice(0, 200);
    throw new Error(`HeyGen ${method} ${pathname} → HTTP ${res.status}: ${msg}`);
  }
  return json;
}

// ── Avatares ────────────────────────────────────────────────────────────
// GET /v2/avatars → { avatars, talking_photos }
async function listarAvatares() {
  const j = await _req('GET', '/v2/avatars');
  return {
    avatars: j.data?.avatars || [],
    talkingPhotos: j.data?.talking_photos || [],
  };
}

// ── Vozes ───────────────────────────────────────────────────────────────
// GET /v2/voices → data.voices
async function listarVozes() {
  const j = await _req('GET', '/v2/voices');
  return j.data?.voices || [];
}

// ── Upload de asset (áudio externo para lip-sync) ───────────────────────
// POST upload.heygen.com/v1/asset — body binário RAW (NÃO multipart),
// Content-Type = MIME do arquivo. Retorna { id, file_type, url, created_ts }.
async function uploadAsset(buffer, mimeType) {
  _assertKey();
  if (!buffer || !mimeType) throw new Error('uploadAsset exige (buffer, mimeType)');
  const res = await fetch(`${UPLOAD_BASE}/v1/asset`, {
    method: 'POST',
    headers: { 'X-API-KEY': _key(), 'Content-Type': mimeType },
    body: buffer,
  });
  const raw = await res.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
  if (!res.ok || json?.error) {
    const msg = json?.error?.message || json?.error || raw.slice(0, 200);
    throw new Error(`HeyGen upload /v1/asset → HTTP ${res.status}: ${msg}`);
  }
  return json.data || json;
}

// ── Geração de vídeo ────────────────────────────────────────────────────
// POST /v2/video/generate — assíncrono, retorna { video_id }.
// Modos de voz (mutuamente exclusivos):
//   - TTS interno HeyGen → passar { voiceId, script }
//   - áudio externo (lip-sync, voz natural) → passar { audioAssetId } OU { audioUrl }
async function criarVideo(opts = {}) {
  const cfg = defaultConfig();
  const avatarId    = opts.avatarId    || cfg.avatarId;
  const avatarStyle = opts.avatarStyle || 'normal';
  const dimension   = opts.dimension   || cfg.dimension || { width: 1280, height: 720 };
  const { script, voiceId, audioAssetId, audioUrl, background } = opts;
  const title = opts.title
    || `${cfg.titlePrefix || 'Vídeo'} ${new Date().toISOString().slice(0, 10)}`;

  if (!avatarId) throw new Error('criarVideo exige avatarId (ou um default em heygen-config.json)');
  if (audioAssetId && audioUrl) {
    throw new Error('audioAssetId e audioUrl são mutuamente exclusivos');
  }

  // Monta o objeto voice conforme o modo escolhido.
  let voice;
  if (audioAssetId) {
    voice = { type: 'audio', audio_asset_id: audioAssetId };
  } else if (audioUrl) {
    voice = { type: 'audio', audio_url: audioUrl };
  } else {
    const vId = voiceId || cfg.voiceId;
    if (!vId || !script) {
      throw new Error('TTS interno exige voiceId e script — ou forneça audioAssetId/audioUrl');
    }
    voice = { type: 'text', input_text: script, voice_id: vId };
  }

  const videoInput = {
    character: { type: 'avatar', avatar_id: avatarId, avatar_style: avatarStyle },
    voice,
  };
  if (background) videoInput.background = background;

  const j = await _req('POST', '/v2/video/generate', {
    body: { video_inputs: [videoInput], dimension, title },
  });
  return j.data || j; // { video_id }
}

// ── Status / polling ────────────────────────────────────────────────────
// GET /v1/video_status.get?video_id= → status: pending|processing|completed|failed
async function getStatus(videoId) {
  if (!videoId) throw new Error('getStatus exige videoId');
  const j = await _req('GET', '/v1/video_status.get', { query: { video_id: videoId } });
  return j.data || j;
}

// Faz poll de getStatus até completed/failed. Intervalo padrão 10s.
async function aguardarConclusao(videoId, { intervalMs = 10000, maxMs = VIDEO_TIMEOUT_MS } = {}) {
  const inicio = Date.now();
  for (;;) {
    const st = await getStatus(videoId);
    if (st.status === 'completed') return st;
    if (st.status === 'failed') {
      throw new Error(`HeyGen vídeo ${videoId} falhou: ${st.error?.message || st.error || 'sem detalhe'}`);
    }
    if (Date.now() - inicio > maxMs) {
      throw new Error(`HeyGen vídeo ${videoId}: timeout de ${maxMs}ms (último status: ${st.status})`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// ── Listar / cancelar vídeos ────────────────────────────────────────────
async function listarVideos({ limit = 20, token } = {}) {
  const query = { limit };
  if (token) query.token = token;
  const j = await _req('GET', '/v1/video.list', { query });
  return j.data || j;
}

async function cancelarVideo(videoId) {
  if (!videoId) throw new Error('cancelarVideo exige videoId');
  return _req('POST', '/v1/video.delete', { body: { video_id: videoId } });
}

// ── Download do MP4 ─────────────────────────────────────────────────────
// video_url é uma URL pré-assinada temporária — GET puro, SEM API key.
async function baixarMp4(videoUrl, destPath) {
  if (!videoUrl) throw new Error('baixarMp4 exige videoUrl');
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`baixarMp4 → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (destPath) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return { path: destPath, bytes: buf.length };
  }
  return buf;
}

// ── Healthcheck ─────────────────────────────────────────────────────────
async function health() {
  if (!_key()) {
    return { name: 'HeyGen', status: 'disabled', message: 'HEYGEN_API_KEY não configurada' };
  }
  try {
    const vozes = await listarVozes();
    return { name: 'HeyGen', status: 'healthy', message: `HeyGen API v2 operacional (${vozes.length} vozes)` };
  } catch (e) {
    return { name: 'HeyGen', status: 'error', message: e.message };
  }
}

module.exports = {
  listarAvatares, listarVozes, uploadAsset,
  criarVideo, getStatus, aguardarConclusao,
  listarVideos, cancelarVideo, baixarMp4,
  health, isEnabled, defaultConfig,
};
