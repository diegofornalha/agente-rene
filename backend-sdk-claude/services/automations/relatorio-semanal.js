// Relatório semanal — roda todo domingo às 21h.
// Compila dados de coaching, pipeline e performance da semana
// e envia relatório executivo no WhatsApp do Lucas.

const twenty = require('./twenty-client');
const wa = require('./whatsapp-sender');

const LUCAS_JID = '5516981591482@s.whatsapp.net';

function _weekRange() {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function _formatCurrency(amountMicros) {
  if (!amountMicros) return 'R$ 0';
  const val = amountMicros / 1000000;
  if (val >= 1000000) return `R$ ${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000) return `R$ ${(val / 1000).toFixed(0)}k`;
  return `R$ ${val.toFixed(0)}`;
}

function _formatDate(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
}

function _gradeEmoji(nota) {
  const map = { A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' };
  return map[nota] || '⚪';
}

async function _fetchWeekCoaching(start, end) {
  try {
    const all = await twenty.listAll('coachingReunioes', {
      orderBy: 'dataReuniao[DescNullsLast]',
    });
    return all.filter(r => {
      if (!r.dataReuniao) return false;
      const d = new Date(r.dataReuniao);
      return d >= start && d <= end;
    });
  } catch (e) {
    console.error('relatorio: erro buscando coaching:', e.message);
    return [];
  }
}

async function _fetchPipeline() {
  try {
    return await twenty.listAll('opportunities', {
      orderBy: 'createdAt[DescNullsLast]',
    });
  } catch (e) {
    console.error('relatorio: erro buscando pipeline:', e.message);
    return [];
  }
}

function _buildCloserStats(coaching) {
  const byCloser = {};
  for (const r of coaching) {
    const name = r.name?.split('·')[0]?.trim() || r.vendedor || 'Desconhecido';
    const vendedor = r.vendedor || name;
    if (!byCloser[vendedor]) {
      byCloser[vendedor] = { name: vendedor, reunioes: 0, notas: [], crossSellPerdido: 0, crossSellTotal: 0, probAlta: 0 };
    }
    const s = byCloser[vendedor];
    s.reunioes++;
    if (r.notaGeral) s.notas.push(r.notaGeral);
    if (r.crossSellPerdido === 'SIM') s.crossSellPerdido++;
    s.crossSellTotal++;
    if (r.probabilidadeAquisicao === 'ALTA') s.probAlta++;
  }

  const gradeOrder = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  for (const s of Object.values(byCloser)) {
    const sum = s.notas.reduce((acc, n) => acc + (gradeOrder[n] ?? 2), 0);
    s.notaMedia = s.notas.length > 0 ? sum / s.notas.length : 0;
    s.notaMediaLabel = s.notaMedia >= 3.5 ? 'A' : s.notaMedia >= 2.5 ? 'B' : s.notaMedia >= 1.5 ? 'C' : s.notaMedia >= 0.5 ? 'D' : 'F';
    s.crossSellRate = s.crossSellTotal > 0 ? Math.round((1 - s.crossSellPerdido / s.crossSellTotal) * 100) : 0;
  }

  return Object.values(byCloser).sort((a, b) => b.notaMedia - a.notaMedia);
}

function _buildPipelineStats(opportunities) {
  const activeStages = ['LEAD', 'QUALIFICADO', 'PROPOSTA', 'NEGOCIACAO', 'NDA', 'REUNIAO_COMERCIAL', 'REUNIAO_TECNICA'];
  const active = opportunities.filter(o => !o.deletedAt && activeStages.some(s => (o.stage || '').includes(s)));

  let totalValue = 0;
  let probAltaValue = 0;
  let staleDeals = 0;
  const staleThreshold = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const o of active) {
    const val = o.amount?.amountMicros || 0;
    totalValue += val;
    if ((o.temperatura || '').includes('QUENTE') || (o.probabilidadeAquisicao || '') === 'ALTA') {
      probAltaValue += val;
    }
    const lastUpdate = new Date(o.updatedAt || o.createdAt).getTime();
    if (now - lastUpdate > staleThreshold) staleDeals++;
  }

  const byStage = {};
  for (const o of active) {
    const stage = o.stage || 'OUTRO';
    if (!byStage[stage]) byStage[stage] = { count: 0, value: 0 };
    byStage[stage].count++;
    byStage[stage].value += (o.amount?.amountMicros || 0);
  }

  return { active: active.length, totalValue, probAltaValue, staleDeals, byStage };
}

function _buildReport(coaching, closerStats, pipelineStats, weekRange) {
  const startStr = _formatDate(weekRange.start);
  const endStr = _formatDate(weekRange.end);
  const messages = [];

  // Mensagem 1: Header
  let header = `📊 *RELATÓRIO SEMANAL — VISÃO CEO*\n📅 ${startStr} a ${endStr}\n`;
  header += `\n*Resumo:*`;
  header += `\n  • ${coaching.length} reuniões avaliadas`;

  const totalCrossSell = coaching.filter(c => c.crossSellPerdido === 'SIM').length;
  const crossSellRate = coaching.length > 0 ? Math.round((1 - totalCrossSell / coaching.length) * 100) : 0;
  header += `\n  • Cross-sell rate: ${crossSellRate}% (meta: 60%+)`;

  const probAlta = coaching.filter(c => c.probabilidadeAquisicao === 'ALTA').length;
  header += `\n  • ${probAlta} reuniões com prob. alta de aquisição`;

  header += `\n  • Pipeline ativo: ${pipelineStats.active} deals (${_formatCurrency(pipelineStats.totalValue)})`;
  if (pipelineStats.staleDeals > 0) {
    header += `\n  • ⚠️ ${pipelineStats.staleDeals} deals parados há +7 dias`;
  }
  messages.push(header);

  // Mensagem 2: Ranking de closers
  if (closerStats.length > 0) {
    let ranking = `🏆 *RANKING DO TIME*\n`;
    for (let i = 0; i < closerStats.length; i++) {
      const s = closerStats[i];
      const emoji = _gradeEmoji(s.notaMediaLabel);
      ranking += `\n${i + 1}. ${emoji} *${s.name}* — ${s.notaMediaLabel} (${s.reunioes} reuniões)`;
      ranking += `\n   Cross-sell: ${s.crossSellRate}% | Prob. Alta: ${s.probAlta}`;
    }
    messages.push(ranking);
  }

  // Mensagem 3: Alertas
  const alerts = [];
  const lowPerformers = closerStats.filter(s => s.notaMediaLabel === 'D' || s.notaMediaLabel === 'F');
  if (lowPerformers.length > 0) {
    alerts.push(`🔴 *Closers abaixo da meta:* ${lowPerformers.map(s => s.name).join(', ')} — precisam coaching urgente`);
  }
  if (crossSellRate < 40) {
    alerts.push(`🟠 *Cross-sell abaixo de 40%* — time está vendendo mono-produto`);
  }
  if (pipelineStats.staleDeals > 3) {
    alerts.push(`🟡 *${pipelineStats.staleDeals} deals parados* — possível gargalo de follow-up`);
  }
  const zeroCrossSell = closerStats.filter(s => s.crossSellRate === 0 && s.reunioes >= 2);
  if (zeroCrossSell.length > 0) {
    alerts.push(`🔴 *Zero cross-sell:* ${zeroCrossSell.map(s => s.name).join(', ')} — nenhuma segunda linha oferecida`);
  }

  if (alerts.length > 0) {
    messages.push(`⚠️ *ALERTAS*\n\n${alerts.join('\n\n')}`);
  }

  // Mensagem 4: Pipeline por estágio
  if (Object.keys(pipelineStats.byStage).length > 0) {
    let pipeline = `📈 *PIPELINE POR ESTÁGIO*\n`;
    const stageNames = {
      LEAD: 'Lead', QUALIFICADO: 'Qualificado', PROPOSTA: 'Proposta',
      NEGOCIACAO: 'Negociação', NDA: 'NDA', REUNIAO_COMERCIAL: 'R1 (Comercial)',
      REUNIAO_TECNICA: 'R2 (Técnica)', OUTRO: 'Outro',
    };
    for (const [stage, data] of Object.entries(pipelineStats.byStage)) {
      const label = stageNames[stage] || stage;
      pipeline += `\n  ${label}: ${data.count} deals — ${_formatCurrency(data.value)}`;
    }
    if (pipelineStats.probAltaValue > 0) {
      pipeline += `\n\n💰 *Valor provável:* ${_formatCurrency(pipelineStats.probAltaValue)}`;
    }
    messages.push(pipeline);
  }

  // Mensagem 5: Próximos passos
  let nextSteps = `✅ *PRÓXIMOS PASSOS SUGERIDOS*\n`;
  if (lowPerformers.length > 0) {
    nextSteps += `\n1. Agendar coaching 1:1 com ${lowPerformers.map(s => s.name).join(' e ')}`;
  }
  if (crossSellRate < 60) {
    nextSteps += `\n${lowPerformers.length > 0 ? '2' : '1'}. Reforçar mapa de cross-sell no grupo de vendas`;
  }
  if (pipelineStats.staleDeals > 0) {
    nextSteps += `\n${lowPerformers.length > 0 ? '3' : '2'}. Revisar ${pipelineStats.staleDeals} deals parados — definir ação ou descarte`;
  }
  nextSteps += `\n\n_Relatório gerado automaticamente pelo René_`;
  messages.push(nextSteps);

  return messages;
}

async function run() {
  const week = _weekRange();

  const [coaching, opportunities] = await Promise.all([
    _fetchWeekCoaching(week.start, week.end),
    _fetchPipeline(),
  ]);

  const closerStats = _buildCloserStats(coaching);
  const pipelineStats = _buildPipelineStats(opportunities);
  const messages = _buildReport(coaching, closerStats, pipelineStats, week);

  try {
    await wa.sendChunked(LUCAS_JID, messages, 2000);
    console.log(`📊 relatório semanal enviado: ${messages.length} mensagens, ${coaching.length} reuniões, ${opportunities.length} oportunidades`);
    return { sent: messages.length, coaching: coaching.length, pipeline: opportunities.length };
  } catch (e) {
    console.error('relatorio: falha ao enviar:', e.message);
    return { error: e.message };
  }
}

module.exports = { run };
