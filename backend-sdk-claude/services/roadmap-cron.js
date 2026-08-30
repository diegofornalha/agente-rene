// roadmap-cron.js — Dispara avisos diários do Roadmap Paraguai (Daniel)
// no grupo Rota Fiscal #333 via /api/whatsapp/say.
// Roda dentro do processo Node (node-cron) pra evitar crontab/launchd bloqueados.

const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'roadmap-cron.sh');

let _task = null;

function start() {
  if (_task) return;
  // Todo dia às 08:03, de 01/07 a 27/07/2026
  _task = cron.schedule('3 8 * * *', () => {
    const now = new Date();
    const month = now.getMonth() + 1; // 1-based
    const day = now.getDate();
    // Só dispara em julho, dias 1-27
    if (month !== 7 || day > 27) return;
    console.log(`📋 roadmap-cron: disparando script para ${String(day).padStart(2, '0')}/07`);
    execFile('/bin/bash', [SCRIPT], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) console.error('📋 roadmap-cron erro:', err.message);
      if (stderr) console.error('📋 roadmap-cron stderr:', stderr);
    });
  });
  console.log('📋 Roadmap Paraguai cron ativo — avisos diários às 08:03 (julho/2026)');
}

function stop() {
  if (_task) { _task.stop(); _task = null; }
}

module.exports = { start, stop };
