'use strict';
/**
 * services/video-postprocess.js — pós-edição ffmpeg de vídeos HeyGen.
 *
 * acelerar(): acelera VÍDEO e ÁUDIO na MESMA proporção, preservando o lip-sync.
 *
 * ⚠️ A pegadinha do lip-sync: o `speed` do ElevenLabs faz time-stretch só no
 * áudio, depois do TTS. O HeyGen analisa os fonemas do áudio pra animar a boca
 * — áudio comprimido digitalmente confunde o modelo e QUEBRA o lip-sync.
 * Regra: nunca acelerar pelo `speed` do ElevenLabs (manter speed 1.0). Pra
 * acelerar, usar este módulo DEPOIS que o vídeo já está pronto.
 *
 * Portado do bridge-lucrecia (heygen/video-postprocess.js).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

function _run(args, label) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('error', e => reject(new Error(`${label}: ${e.message} (ffmpeg no PATH? defina FFMPEG_BIN)`)));
    ff.on('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${label} exit=${code}: ${stderr.slice(-300)}`)));
  });
}

// atempo só aceita 0.5–2.0 por instância — encadeia pra fatores fora disso.
function _atempoChain(fator) {
  const parts = [];
  let r = fator;
  while (r > 2.0) { parts.push('atempo=2.0'); r /= 2.0; }
  while (r < 0.5) { parts.push('atempo=0.5'); r /= 0.5; }
  parts.push(`atempo=${r}`);
  return parts.join(',');
}

/**
 * Acelera (ou desacelera) um MP4 mantendo o lip-sync sincronizado.
 * @param {string} input  - caminho do MP4 de entrada
 * @param {string} output - caminho do MP4 de saída
 * @param {object} [opts]
 * @param {number} [opts.fator=1.2] - 0 < fator <= 4. Range recomendado p/ Reels: 1.0–1.2.
 * @returns {{ ok:boolean, outputPath:string, outputSizeMB:number, fator:number }}
 */
async function acelerar(input, output, { fator = 1.2 } = {}) {
  fator = Number(fator);
  if (!(fator > 0 && fator <= 4)) throw new Error('acelerar: fator deve estar em (0, 4]');
  if (!fs.existsSync(input)) throw new Error(`acelerar: vídeo de entrada não existe: ${input}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  if (fator === 1) {
    // sem aceleração — só copia (mantém o contrato de "sempre gera o output").
    fs.copyFileSync(input, output);
  } else {
    await _run([
      '-y', '-i', input,
      '-filter:v', `setpts=PTS/${fator}`,
      '-filter:a', _atempoChain(fator),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      output,
    ], 'ffmpeg acelerar');
  }

  const bytes = fs.statSync(output).size;
  return { ok: true, outputPath: output, outputSizeMB: +(bytes / 1048576).toFixed(2), fator };
}

module.exports = { acelerar };
