/**
 * account-status.js — estado da conta do Claude Code nesta máquina, para a status line do meu-bot.
 *
 * Lê o que o statusline.sh do Claude Code já deixa em ~/.cache/claude-statusline/:
 *  - profile.json    {email, assento}              (perfil OAuth, cache de 10 min)
 *  - ratelimits.json {session_pct, weekly_pct, session_resets, weekly_resets, updated}
 * O cache só é renovado quando um Claude Code interativo roda na máquina, então `updated` vai junto
 * para o app mostrar a idade. Sem cache → null nos campos. Mesmo arquivo em backend-colima/ e
 * backend-vm/services/ (copiar, não editar só um).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** {email, assento, sessionPct, weeklyPct, sessionResets, weeklyResets, updated} com null onde não há dado. */
function readClaudeStatus(home = os.homedir()) {
  const dir = path.join(home, '.cache', 'claude-statusline');
  const profile = readJson(path.join(dir, 'profile.json')) || {};
  const limits = readJson(path.join(dir, 'ratelimits.json')) || {};
  return {
    email: typeof profile.email === 'string' && profile.email ? profile.email : null,
    assento: typeof profile.assento === 'string' && profile.assento ? profile.assento : null,
    sessionPct: num(limits.session_pct),
    weeklyPct: num(limits.weekly_pct),
    /** Epoch em segundos. */
    sessionResets: num(limits.session_resets),
    weeklyResets: num(limits.weekly_resets),
    updated: num(limits.updated),
  };
}

module.exports = { readClaudeStatus };
