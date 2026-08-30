// Briefing pré-reunião — roda a cada 30min (8h-18h, seg-sex).
// Verifica Google Calendar para reuniões nos próximos 35min,
// cruza com Twenty CRM (empresa, oportunidades, coaching) e
// envia briefing no WhatsApp do Lucas.

const googleAuth = require('../google/google-auth');
const googleCal = require('../google/google-calendar');
const twenty = require('./twenty-client');
const wa = require('./whatsapp-sender');
const fs = require('fs-extra');
const path = require('path');

const LUCAS_JID = '5516981591482@s.whatsapp.net';
const SENT_LOG = path.join(__dirname, '..', '..', 'data', 'briefing-sent.json');
const LOOKAHEAD_MIN = 35;

const CROSS_SELL_MAP = {
  varejo: ['L1 Federal (ICMS/IPI)', 'L2 Previdenciário', 'Corporativa (regime tributário)'],
  industria: ['L1 Federal', 'L2 ICMS/IPI', 'Corporativa (planejamento fiscal)', 'Financeira'],
  servicos: ['L1 Federal', 'L2 Previdenciário (patronal)', 'Corporativa'],
  importacao: ['L1 Federal', 'L2 ICMS/IPI (importação)', 'Corporativa (regime especial)'],
  agro: ['L1 Federal', 'L2 ICMS', 'Corporativa (incentivos fiscais)'],
  default: ['L1 Federal', 'L2 ICMS/IPI', 'L2 Previdenciário', 'Corporativa', 'Financeira'],
};

function _loadSent() {
  try { return fs.existsSync(SENT_LOG) ? fs.readJsonSync(SENT_LOG) : {}; } catch { return {}; }
}

function _saveSent(data) {
  fs.ensureDirSync(path.dirname(SENT_LOG));
  fs.writeJsonSync(SENT_LOG, data, { spaces: 2 });
}

function _alreadySent(eventId) {
  const sent = _loadSent();
  const today = new Date().toISOString().slice(0, 10);
  return sent[eventId] === today;
}

function _markSent(eventId) {
  const sent = _loadSent();
  const today = new Date().toISOString().slice(0, 10);
  sent[eventId] = today;
  const keys = Object.keys(sent);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 100)) delete sent[k];
  }
  _saveSent(sent);
}

function _inferSegment(companyName) {
  const n = (companyName || '').toLowerCase();
  if (/import|export|trading|comex/.test(n)) return 'importacao';
  if (/industria|fabrica|manufat|metalurg/.test(n)) return 'industria';
  if (/varejo|comercio|loja|mercado|magazine/.test(n)) return 'varejo';
  if (/agro|rural|fazenda|granja|agri/.test(n)) return 'agro';
  return 'default';
}

function _formatCurrency(amountMicros) {
  if (!amountMicros) return null;
  const val = amountMicros / 1000000;
  return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function _findCompanyContext(eventSummary, attendees) {
  try {
    const companies = await twenty.listRecords('companies', { limit: 60 });
    const searchTerms = [
      ...(attendees || []).map(a => a.email?.split('@')[1]?.split('.')[0]).filter(Boolean),
      ...(eventSummary || '').split(/[\s·\-|<>]+/).filter(w => w.length > 3),
    ];
    for (const company of companies) {
      const cName = (company.name || '').toLowerCase();
      for (const term of searchTerms) {
        if (cName.includes(term.toLowerCase())) return company;
      }
    }
  } catch (e) {
    console.error('briefing: erro buscando empresa no CRM:', e.message);
  }
  return null;
}

async function _findOpportunities(companyId) {
  if (!companyId) return [];
  try {
    return await twenty.listRecords('opportunities', {
      filter: `companyId[eq]:"${companyId}"`,
      limit: 10,
      orderBy: 'createdAt[DescNullsLast]',
    });
  } catch (e) {
    console.error('briefing: erro buscando oportunidades:', e.message);
    return [];
  }
}

async function _findCoaching(companyId) {
  if (!companyId) return [];
  try {
    return await twenty.listRecords('coachingReunioes', {
      filter: `companyId[eq]:"${companyId}"`,
      limit: 5,
      orderBy: 'dataReuniao[DescNullsLast]',
    });
  } catch (e) {
    console.error('briefing: erro buscando coaching:', e.message);
    return [];
  }
}

function _buildBriefing(event, company, opportunities, coaching) {
  const startTime = new Date(event.start.dateTime || event.start.date);
  const hora = startTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

  const parts = [];
  parts.push(`📋 *BRIEFING PRÉ-REUNIÃO*\n⏰ ${hora} — ${event.summary}`);

  if (event.location) parts.push(`📍 ${event.location}`);
  if (event.hangoutLink) parts.push(`🔗 ${event.hangoutLink}`);

  if (company) {
    const segment = _inferSegment(company.name);
    let companyBlock = `\n🏢 *${company.name}*`;
    if (company.domainName?.primaryLinkUrl) companyBlock += `\n🌐 ${company.domainName.primaryLinkUrl}`;
    if (company.address?.addressCity) companyBlock += `\n📍 ${company.address.addressCity}/${company.address.addressState || ''}`;
    if (company.employees) companyBlock += `\n👥 ${company.employees} funcionários`;
    if (company.annualRecurringRevenue?.amountMicros) {
      companyBlock += `\n💰 Faturamento: ${_formatCurrency(company.annualRecurringRevenue.amountMicros)}`;
    }
    parts.push(companyBlock);

    if (opportunities.length > 0) {
      let oppBlock = '\n📊 *Histórico no CRM:*';
      for (const opp of opportunities.slice(0, 5)) {
        const stage = opp.stage || '?';
        const closer = opp.closerNome || '?';
        const valor = _formatCurrency(opp.amount?.amountMicros);
        const tags = opp.tagsOrigem || '';
        oppBlock += `\n  • ${opp.name || 'Sem nome'} — ${stage}${valor ? ` (${valor})` : ''} — Closer: ${closer}`;
        if (tags) oppBlock += ` — ${tags}`;
      }
      parts.push(oppBlock);
    } else {
      parts.push('\n🆕 *Cliente novo* — sem histórico no CRM');
    }

    if (coaching.length > 0) {
      const last = coaching[0];
      let coachBlock = '\n🎓 *Último coaching:*';
      coachBlock += `\n  Nota: ${last.notaGeral || '?'} | Vendedor: ${last.vendedor || '?'}`;
      if (last.crossSellPerdido === 'SIM') coachBlock += '\n  ⚠️ Cross-sell perdido na última reunião';
      if (last.pontoAMelhorar) coachBlock += `\n  📌 Melhorar: ${last.pontoAMelhorar.slice(0, 150)}`;
      parts.push(coachBlock);
    }

    const crossSellLines = CROSS_SELL_MAP[segment] || CROSS_SELL_MAP.default;
    const offeredLines = opportunities.flatMap(o => (o.tagsOrigem || '').toLowerCase().split(/[,;|]/));
    const suggestions = crossSellLines.filter(l => !offeredLines.some(o => o.includes(l.toLowerCase().slice(0, 5))));
    if (suggestions.length > 0) {
      parts.push(`\n🎯 *Cross-sell potencial:*\n${suggestions.map(s => `  → ${s}`).join('\n')}`);
    }
  } else {
    parts.push('\nℹ️ Empresa não encontrada no CRM — verificar se é prospect novo');
    const defaultCross = CROSS_SELL_MAP.default;
    parts.push(`\n🎯 *Linhas para oferecer:*\n${defaultCross.map(s => `  → ${s}`).join('\n')}`);
  }

  const attendeeNames = (event.attendees || [])
    .filter(a => a.email !== 'lucas@lucasjuridico.com')
    .map(a => a.displayName || a.email)
    .join(', ');
  if (attendeeNames) parts.push(`\n👤 *Participantes:* ${attendeeNames}`);

  return parts.join('\n');
}

async function run() {
  if (!googleAuth.isAuthenticated()) {
    console.log('briefing: Google Calendar não autenticado — pulando');
    return { skipped: true, reason: 'google_not_authenticated' };
  }

  const now = new Date();
  const lookahead = new Date(now.getTime() + LOOKAHEAD_MIN * 60 * 1000);

  let events;
  try {
    events = await googleCal.listEvents({
      timeMin: now.toISOString(),
      timeMax: lookahead.toISOString(),
      maxResults: 10,
    });
  } catch (e) {
    console.error('briefing: erro lendo calendar:', e.message);
    return { error: e.message };
  }

  const meetingEvents = events.filter(e => {
    const summary = (e.summary || '').toLowerCase();
    return !summary.includes('almoço') && !summary.includes('pessoal')
      && !summary.includes('bloco') && e.start?.dateTime;
  });

  if (meetingEvents.length === 0) {
    return { sent: 0, reason: 'no_meetings_in_window' };
  }

  let sent = 0;
  for (const event of meetingEvents) {
    if (_alreadySent(event.id)) continue;

    const attendees = event.attendees || [];
    const company = await _findCompanyContext(event.summary, attendees);
    const opportunities = company ? await _findOpportunities(company.id) : [];
    const coaching = company ? await _findCoaching(company.id) : [];

    const briefing = _buildBriefing(event, company, opportunities, coaching);

    try {
      await wa.send(LUCAS_JID, briefing);
      _markSent(event.id);
      sent++;
      console.log(`📋 briefing enviado: ${event.summary} (${event.id})`);
    } catch (e) {
      console.error(`briefing: falha ao enviar: ${e.message}`);
    }

    if (meetingEvents.indexOf(event) < meetingEvents.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return { sent, total: meetingEvents.length };
}

module.exports = { run };
