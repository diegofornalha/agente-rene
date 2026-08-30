/**
 * HeyGen API Service
 *
 * Integração com a API v2 do HeyGen para:
 * - Geração de vídeos com avatar
 * - Listagem de avatares disponíveis
 * - Listagem de vozes
 * - Upload de áudio para voice cloning
 * - Consulta de status de vídeo
 */

const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');

const API_BASE = 'https://api.heygen.com';
const API_KEY = process.env.HEYGEN_API_KEY;

// Cache local de avatares e vozes (evita re-fetch)
let avatarCache = null;
let voiceCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

function headers(contentType = 'application/json') {
  const h = {
    'X-Api-Key': API_KEY,
    'Accept': 'application/json',
  };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

async function apiCall(method, endpoint, body = null, customHeaders = null) {
  if (!API_KEY) throw new Error('HEYGEN_API_KEY não configurada no .env');

  const url = `${API_BASE}${endpoint}`;
  const opts = {
    method,
    headers: customHeaders || headers(),
  };
  if (body && method !== 'GET') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  const json = await res.json();

  if (!res.ok || json.error) {
    const msg = json.error?.message || json.message || JSON.stringify(json);
    throw new Error(`HeyGen API ${res.status}: ${msg}`);
  }
  return json;
}

// ─── Avatares ──────────────────────────────────────────────

async function listAvatars() {
  const now = Date.now();
  if (avatarCache && (now - cacheTimestamp) < CACHE_TTL) return avatarCache;

  const json = await apiCall('GET', '/v2/avatars');
  avatarCache = json.data?.avatars || json.data || [];
  cacheTimestamp = now;
  return avatarCache;
}

async function getAvatar(avatarId) {
  const avatars = await listAvatars();
  return avatars.find(a => a.avatar_id === avatarId) || null;
}

// ─── Vozes ─────────────────────────────────────────────────

async function listVoices() {
  const now = Date.now();
  if (voiceCache && (now - cacheTimestamp) < CACHE_TTL) return voiceCache;

  const json = await apiCall('GET', '/v2/voices');
  voiceCache = json.data?.voices || json.data || [];
  return voiceCache;
}

// ─── Voice Cloning ─────────────────────────────────────────

/**
 * Faz upload de áudio para criar/treinar um voice clone no HeyGen.
 * @param {string} audioPath - Caminho absoluto do arquivo de áudio (mp3/wav)
 * @param {string} voiceName - Nome descritivo da voz
 * @returns {object} Dados da voz criada (voice_id, etc.)
 */
async function uploadVoiceClone(audioPath, voiceName = 'Clone Lucas') {
  if (!await fs.pathExists(audioPath)) {
    throw new Error(`Arquivo de áudio não encontrado: ${audioPath}`);
  }

  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('voice_name', voiceName);

  const url = `${API_BASE}/v1/voice/clone`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Api-Key': API_KEY,
      ...form.getHeaders(),
    },
    body: form,
  });

  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`HeyGen voice clone ${res.status}: ${json.error?.message || JSON.stringify(json)}`);
  }
  return json.data || json;
}

// ─── Geração de Vídeo ──────────────────────────────────────

/**
 * Gera um vídeo com avatar falante.
 * @param {object} opts
 * @param {string} opts.avatarId - ID do avatar (ou 'default' pra usar o primeiro disponível)
 * @param {string} opts.text - Texto que o avatar vai falar
 * @param {string} [opts.voiceId] - ID da voz (opcional, usa a padrão do avatar)
 * @param {string} [opts.language] - Código do idioma (default: 'pt')
 * @param {string} [opts.quality] - 'draft' | 'standard' | 'high' (default: 'standard')
 * @param {string} [opts.aspectRatio] - '16:9' | '9:16' | '1:1' (default: '16:9')
 * @param {string} [opts.background] - URL de imagem de fundo ou cor hex
 * @returns {object} { video_id, status }
 */
async function generateVideo(opts) {
  const {
    avatarId,
    text,
    voiceId,
    language = 'pt',
    quality = 'standard',
    aspectRatio = '16:9',
    background,
  } = opts;

  if (!text) throw new Error('Texto obrigatório para gerar vídeo');

  // Monta o input de voz
  const voiceInput = voiceId
    ? { type: 'text', voice_id: voiceId, input_text: text, language }
    : { type: 'text', input_text: text, language };

  // Monta o payload
  const payload = {
    video_inputs: [{
      character: {
        type: 'avatar',
        avatar_id: avatarId || 'default',
        avatar_style: 'normal',
      },
      voice: voiceInput,
    }],
    dimension: aspectRatioToDimension(aspectRatio),
    test: quality === 'draft',
  };

  if (background) {
    if (background.startsWith('#') || background.startsWith('rgb')) {
      payload.video_inputs[0].background = { type: 'color', value: background };
    } else {
      payload.video_inputs[0].background = { type: 'image', value: background };
    }
  }

  const json = await apiCall('POST', '/v2/video/generate', payload);
  return {
    video_id: json.data?.video_id,
    status: 'pending',
  };
}

/**
 * Gera vídeo a partir de áudio (em vez de texto).
 * Útil quando já temos o áudio TTS do ElevenLabs.
 */
async function generateVideoFromAudio(opts) {
  const {
    avatarId,
    audioUrl,
    quality = 'standard',
    aspectRatio = '16:9',
    background,
  } = opts;

  if (!audioUrl) throw new Error('audioUrl obrigatório');

  const payload = {
    video_inputs: [{
      character: {
        type: 'avatar',
        avatar_id: avatarId || 'default',
        avatar_style: 'normal',
      },
      voice: {
        type: 'audio',
        audio_url: audioUrl,
      },
    }],
    dimension: aspectRatioToDimension(aspectRatio),
    test: quality === 'draft',
  };

  if (background) {
    payload.video_inputs[0].background = { type: 'color', value: background };
  }

  const json = await apiCall('POST', '/v2/video/generate', payload);
  return {
    video_id: json.data?.video_id,
    status: 'pending',
  };
}

// ─── Status e Download ─────────────────────────────────────

/**
 * Consulta o status de um vídeo em geração.
 * @returns {object} { status, video_url, duration, thumbnail_url, ... }
 */
async function getVideoStatus(videoId) {
  const json = await apiCall('GET', `/v1/video_status.get?video_id=${videoId}`);
  return json.data || json;
}

/**
 * Aguarda um vídeo ficar pronto (polling com backoff).
 * @param {string} videoId
 * @param {number} maxWait - Tempo máximo em ms (default: 5 min)
 * @param {function} onProgress - Callback opcional (status) => void
 * @returns {object} Dados do vídeo completo
 */
async function waitForVideo(videoId, maxWait = 300_000, onProgress = null) {
  const start = Date.now();
  let interval = 5_000; // começa com 5s

  while (Date.now() - start < maxWait) {
    const status = await getVideoStatus(videoId);
    if (onProgress) onProgress(status);

    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(`Vídeo falhou: ${status.error || 'erro desconhecido'}`);

    await new Promise(r => setTimeout(r, interval));
    interval = Math.min(interval * 1.5, 30_000); // backoff até 30s
  }

  throw new Error(`Timeout aguardando vídeo ${videoId} (${maxWait / 1000}s)`);
}

/**
 * Baixa o vídeo finalizado para disco.
 */
async function downloadVideo(videoUrl, outputPath) {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Falha ao baixar vídeo: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, buf);
  return outputPath;
}

// ─── Templates ─────────────────────────────────────────────

async function listTemplates() {
  const json = await apiCall('GET', '/v2/templates');
  return json.data?.templates || json.data || [];
}

async function generateFromTemplate(templateId, variables = {}) {
  const payload = {
    template_id: templateId,
    variables,
    test: false,
  };
  const json = await apiCall('POST', '/v2/template/generate', payload);
  return {
    video_id: json.data?.video_id,
    status: 'pending',
  };
}

// ─── Streaming Avatar (Interactive) ────────────────────────

/**
 * Cria uma sessão de streaming avatar (para uso em tempo real).
 */
async function createStreamingSession(avatarId, voiceId, quality = 'medium') {
  const payload = {
    avatar_id: avatarId,
    voice_id: voiceId,
    quality,
  };
  const json = await apiCall('POST', '/v1/streaming.new', payload);
  return json.data || json;
}

async function sendStreamingText(sessionId, text) {
  const payload = {
    session_id: sessionId,
    text,
  };
  const json = await apiCall('POST', '/v1/streaming.task', payload);
  return json.data || json;
}

async function closeStreamingSession(sessionId) {
  const payload = { session_id: sessionId };
  const json = await apiCall('POST', '/v1/streaming.stop', payload);
  return json.data || json;
}

// ─── Quota / Remaining Credits ─────────────────────────────

async function getQuota() {
  const json = await apiCall('GET', '/v1/video.remaining_quota');
  return json.data || json;
}

// ─── Utilitários ───────────────────────────────────────────

function aspectRatioToDimension(ratio) {
  switch (ratio) {
    case '9:16': return { width: 720, height: 1280 };
    case '1:1': return { width: 1080, height: 1080 };
    case '16:9':
    default: return { width: 1920, height: 1080 };
  }
}

function invalidateCache() {
  avatarCache = null;
  voiceCache = null;
  cacheTimestamp = 0;
}

// ─── Exports ───────────────────────────────────────────────

module.exports = {
  // Core
  listAvatars,
  getAvatar,
  listVoices,
  getQuota,

  // Video generation
  generateVideo,
  generateVideoFromAudio,
  getVideoStatus,
  waitForVideo,
  downloadVideo,

  // Templates
  listTemplates,
  generateFromTemplate,

  // Voice cloning
  uploadVoiceClone,

  // Streaming (interactive avatar)
  createStreamingSession,
  sendStreamingText,
  closeStreamingSession,

  // Utils
  invalidateCache,
};
