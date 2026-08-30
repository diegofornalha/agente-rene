// Lembrete de follow-up — identifica oportunidades ativas sem dataProximoFup
// e envia resumo por closer no WhatsApp do Lucas.

const twenty = require('./twenty-client');
const wa = require('./whatsapp-sender');

const LUCAS_JID = '5516981591482@s.whatsapp.net';

const ACTIVE_STAGES = [
  'FUP', 'PROSPECCAO', 'REUNIAO_COMERCIAL', 'MAPEAMENTO_QUALIFICACAO',
  'APRESENTACAO_TECNICA', 'CONTRATACAO', 'NO_SHOW',
];

const STAGE_LABELS = {
  FUP: 'Follow-up',
  PROSPECCAO: 'Prospecção',
  REUNIAO_COMERCIAL: 'R. Comercial',
  MAPEAMENTO_QUALIFICACAO: 'Qualificação',
  APRESENTACAO_TECNICA: 'Apres. Técnica',
  CONTRATACAO: 'Contratação',
  NO_SHOW: 'No-show',
};

function _isActive(opp) {
  if (opp.deletedAt) return false;
  const stage = opp.stage || '';
  return ACTIVE_STAGES.some(s => stage.includes(s));
}

function _hasFup(opp) {
  return !!opp.dataProximoFup;
}

function _groupByCloser(opps) {
  const groups = {};
  for (const o of opps) {
    const closer = (o.closerNome || '').trim() || 'Sem closer';
    if (!groups[closer]) groups[closer] = [];
    groups[closer].push(o);
  }
  return groups;
}

function _stageBreakdown(opps) {
  const counts = {};
  for (const o of opps) {
    const stage = o.stage || 'OUTRO';
    const label = STAGE_LABELS[stage] || stage;
    counts[label] = (counts[label] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${label}: ${n}`)
    .join(' · ');
}

function _buildMessages(byCloser, totalActive, totalSemFup) {
  const messages = [];
  const today = new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  });

  const closers = Object.entries(byCloser)
    .filter(([name]) => name !== 'Sem closer')
    .sort((a, b) => b[1].length - a[1].length);
  const semCloser = byCloser['Sem closer'] || [];

  let header = `⚠️ *ALERTA — DEALS SEM FOLLOW-UP AGENDADO*`;
  header += `\n📅 ${today}`;
  header += `\n\n*${totalSemFup}* de *${totalActive}* oportunidades ativas estão sem dataProximoFup.`;
  header += `\n\n📊 *Ranking por closer:*`;
  for (const [name, opps] of closers) {
    header += `\n  • *${name}*: ${opps.length}`;
  }
  if (semCloser.length > 0) {
    header += `\n  • _Sem closer_: ${semCloser.length}`;
  }
  messages.push(header);

  const TOP_N = 5;
  const topClosers = closers.slice(0, TOP_N);
  let detail = `🔍 *TOP ${TOP_N} CLOSERS — DETALHAMENTO*\n`;
  for (const [name, opps] of topClosers) {
    detail += `\n👤 *${name}* (${opps.length})`;
    detail += `\n${_stageBreakdown(opps)}`;
    const top3 = opps.slice(0, 3);
    for (const o of top3) {
      const label = STAGE_LABELS[o.stage] || o.stage;
      detail += `\n  → ${o.name} _(${label})_`;
    }
    if (opps.length > 3) detail += `\n  _+${opps.length - 3} mais_`;
  }
  messages.push(detail);

  let footer = `✅ *Ação sugerida:*`;
  footer += `\nPeça para cada closer preencher dataProximoFup nos deals ativos. `;
  footer += `Prioridade: Contratação > Apres. Técnica > Qualificação.`;
  footer += `\n\n_Lembrete automático — René_`;
  messages.push(footer);

  return messages;
}

async function run({ dryRun = false } = {}) {
  const allOpps = await twenty.listAll('opportunities');
  const active = allOpps.filter(_isActive);
  const semFup = active.filter(o => !_hasFup(o));

  if (semFup.length === 0) {
    console.log('lembrete-fup: todos os deals ativos têm dataProximoFup preenchido');
    return { sent: 0, total: active.length, semFup: 0 };
  }

  const byCloser = _groupByCloser(semFup);
  const messages = _buildMessages(byCloser, active.length, semFup.length);

  if (dryRun) {
    console.log('--- DRY RUN ---');
    for (const m of messages) console.log(m + '\n---');
    return { dryRun: true, messages: messages.length, total: active.length, semFup: semFup.length, byCloser: Object.fromEntries(Object.entries(byCloser).map(([k, v]) => [k, v.length])) };
  }

  await wa.sendChunked(LUCAS_JID, messages, 2000);
  console.log(`⚠️ lembrete-fup enviado: ${messages.length} msgs, ${semFup.length}/${active.length} deals sem FUP`);
  return { sent: messages.length, total: active.length, semFup: semFup.length };
}

module.exports = { run };
