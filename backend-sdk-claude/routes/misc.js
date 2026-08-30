'use strict';
// routes/misc.js — pipelines René: tradução/publicação Instagram, stories,
// tradução de imagem, modo autônomo, PDF filler, skills e agents via HTTP.

const express = require('express');
const { _bearerAuth } = require('../lib/bearer-auth');
const taskRunner = require('../services/tasks/task-runner');
const logger = require('../services/logger');

module.exports = function mount(app, { io, RENE_WS }) {

// POST /api/translate-instagram — traduz post do Instagram e publica nas 3 contas
app.post('/api/translate-instagram', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { url, to, message_id, rebrand_name, rebrand_handle, rebrand_photo, mode } = req.body;
  if (!url || !to) {
    return res.status(400).json({ error: 'url and to (LID) are required' });
  }

  // Extrair shortcode da URL pra criar pasta isolada
  const scMatch = url.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
  const shortcode = scMatch ? scMatch[1] : `post_${Date.now()}`;
  const workDir = `${RENE_WS}/media/jobs/${shortcode}`;
  const scriptsDir = `${RENE_WS}/scripts`;
  const igDir = `${RENE_WS}/scripts/instagram`;

  // mode: "translate" (default) ou "rebrand" (só troca nome/handle/foto)
  const isRebrand = mode === 'rebrand' && rebrand_name && rebrand_handle;

  let imageStep;
  if (isRebrand) {
    const photoFlag = rebrand_photo ? ` --photo "${rebrand_photo}"` : '';
    imageStep = `2. Para CADA imagem baixada em ${workDir}/images/ (ig_*_.jpg), customizar:
cd ${scriptsDir} && uv run rebrand-image.py -i ARQUIVO_ORIGINAL -f ${workDir}/translated/NOME_ptbr.png --name "${rebrand_name}" --handle "${rebrand_handle}"${photoFlag}`;
  } else {
    imageStep = `2. Para CADA imagem baixada em ${workDir}/images/ (ig_*_.jpg), traduzir:
cd ${scriptsDir} && uv run translate-image.py -i ARQUIVO_ORIGINAL -f ${workDir}/translated/NOME_ptbr.png`;
  }

  let captionStep;
  if (isRebrand) {
    captionStep = `3. Ler a legenda em ${workDir}/images/ig_${shortcode}_caption.txt. Substituir @ do autor por "${rebrand_handle}". Adaptar CTA.`;
  } else {
    captionStep = `3. Ler a legenda em ${workDir}/images/ig_${shortcode}_caption.txt e traduzir para PT-BR. Adaptar CTA (ex: "Comenta CREAR" → "Comenta claude").`;
  }

  const prompt = `${isRebrand ? 'Customiza' : 'Traduza'} o post do Instagram e publica nas 3 contas.

IMPORTANTE: Todos os arquivos ficam na pasta isolada ${workDir}/

0. Criar pastas:
mkdir -p ${workDir}/images ${workDir}/translated

1. Baixar imagens para a pasta isolada:
cd ${scriptsDir} && DOWNLOAD_DIR=${workDir}/images uv run download-instagram.py "${url}"
Se o script não suportar DOWNLOAD_DIR, mover os arquivos: mv ${RENE_WS}/media/images/ig_${shortcode}* ${workDir}/images/

${imageStep}

${captionStep}

4. Publicar nas 3 contas do Instagram (uma de cada vez, usar caminhos ABSOLUTOS das imagens em ${workDir}/translated/):
cd ${igDir} && python3 post.py ${workDir}/translated/ig_${shortcode}_1_ptbr.png [${workDir}/translated/ig_${shortcode}_2_ptbr.png ...] "LEGENDA_TRADUZIDA"
cd ${igDir} && python3 post.py --account agentesintegrados ${workDir}/translated/ig_${shortcode}_1_ptbr.png [...] "LEGENDA_TRADUZIDA"
cd ${igDir} && python3 post.py --account openclawde ${workDir}/translated/ig_${shortcode}_1_ptbr.png [...] "LEGENDA_TRADUZIDA"
(post.py converte PNG→JPG automaticamente e limita a 10 imagens)

5. Gerar PDF:
python3 -c "
from PIL import Image; import os, glob, re
base = '${workDir}/translated'
files = sorted(glob.glob(os.path.join(base, 'ig_${shortcode}_*_ptbr.png')), key=lambda f: int(re.search(r'_(\\d+)_ptbr', f).group(1)))
imgs = [Image.open(f).convert('RGB') for f in files]
out = os.path.join(base, '${shortcode}_completo.pdf')
imgs[0].save(out, save_all=True, append_images=imgs[1:])
print(out)
"

6. Postar o PDF como documento/carrossel no LinkedIn:
cd ${RENE_WS}/scripts/linkedin && python3 linkedin_poster.py post "LEGENDA_TRADUZIDA" --doc ${workDir}/translated/${shortcode}_completo.pdf

7. Notificar o usuário que finalizou (respondendo a mensagem original):
curl -s -X POST http://127.0.0.1:18790/api/send-message -H "Content-Type: application/json" -d '{"to": "${to}", "text": "Finalizado ✅"${message_id ? `, "reply_to": "${message_id}"` : ''}}'`;

  const task = taskRunner.createTask({
    prompt,
    workspace: scriptsDir,
    tags: ['instagram', 'translate'],
    source: 'hermes',
    maxTurns: 80,
  });
  res.json({ success: true, taskId: task.id, status: task.status });
});

// POST /api/instagram-stories — publica stories nas 3 contas
app.post('/api/instagram-stories', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { images, text, to } = req.body;
  if (!images || !images.length) {
    return res.status(400).json({ error: 'images array is required' });
  }

  const igDir = `${RENE_WS}/scripts/instagram`;
  const imageList = images.map(i => `"${i}"`).join(' ');

  const prompt = `Publique stories nas 3 contas do Instagram.

1. Postar em todas as contas:
cd ${igDir} && python3 story.py --all ${imageList}

${to ? `2. Notificar o usuário:
curl -s -X POST http://127.0.0.1:18790/api/send-message -H "Content-Type: application/json" -d '{"to": "${to}", "text": "Stories publicados nas 3 contas!"}'` : ''}`;

  const task = taskRunner.createTask({
    prompt,
    workspace: igDir,
    tags: ['instagram', 'stories'],
    source: 'hermes',
    maxTurns: 20,
  });
  res.json({ success: true, taskId: task.id, status: task.status });
});

// POST /api/translate-image — traduz uma imagem avulsa e envia via WhatsApp
app.post('/api/translate-image', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { file, to, lang } = req.body;
  if (!file || !to) {
    return res.status(400).json({ error: 'file and to (LID) are required' });
  }
  const targetLang = lang || 'português brasileiro';
  const prompt = `Traduza a imagem para ${targetLang} e envie pro usuário:

1. Traduzir a imagem:
cd ${RENE_WS}/scripts && uv run translate-image.py -i "${file}" -f "${RENE_WS}/media/translated/$(require('path').basename('${file}', require('path').extname('${file}'))}_ptbr.png"

2. Enviar a imagem traduzida:
curl -s -X POST http://127.0.0.1:18790/api/send-image -H "Content-Type: application/json" -d '{"to": "${to}", "file": "${RENE_WS}/media/translated/NOME_ptbr.png"}'

Substituir NOME pelo nome do arquivo sem extensão.`;

  const task = taskRunner.createTask({
    prompt,
    workspace: `${RENE_WS}/scripts`,
    tags: ['instagram', 'translate'],
    source: 'hermes',
    maxTurns: 10,
  });
  res.json({ success: true, taskId: task.id, status: task.status });
});

// POST /api/autonomous/start — iniciar modo autônomo
app.post('/api/autonomous/start', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const intervalMin = parseInt(req.body.intervalMin || 60);
  taskRunner.startAutonomous(io, intervalMin * 60 * 1000);
  res.json({ success: true, intervalMin });
});

// POST /api/autonomous/stop — parar modo autônomo
app.post('/api/autonomous/stop', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  taskRunner.stopAutonomous();
  res.json({ success: true });
});

// ── PDF filler — preenche templates DETRAN sobrepondo texto no PDF original ──
app.post('/api/preencher/declaracao-residencia', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const { fillDeclaracao } = require('../services/pdf-filler/declaracao-residencia');
    const debug = req.query.debug === '1' || req.body?.debug === true;
    const pdfBytes = await fillDeclaracao(req.body || {}, { debug });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="declaracao-residencia-preenchida.pdf"');
    res.send(pdfBytes);
  } catch (err) {
    logger.error('❌ pdf-filler error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/skills/run', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const result = await require('../services/skills/run-skill').handle(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Agents runner — dispara subagent do Claude Code via Task tool ──
// Diferente de /skills/run: invoca um agente .md em ~/.claude/agents/ usando
// prompt instrutivo + allowedTools:['Task']. Whitelist em services/agents/run-agent.js.
app.post('/api/agents/run', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const result = await require('../services/agents/run-agent').handle(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/agents — lista agentes disponíveis via HTTP (já filtrados por HTTP_DENY)
app.get('/api/agents', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const { listAgents } = require('../services/agents/run-agent');
    res.json({ ok: true, agents: listAgents() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

};
