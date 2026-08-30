// Sincroniza uma sessão de role-play avaliada com o Twenty CRM (objeto roleplay_sessoes).
//
// Usa a REST API do Twenty direto (TWENTY_API_KEY no .env), sem passar pelo MCP —
// mais rápido e confiável pro backend. Só roda se o objeto roleplay_sessoes já
// existir no workspace; se não existir (ou faltar token), falha de forma suave e a
// sessão continua salva localmente. NÃO derruba o fluxo de avaliação.
//
// Campos esperados no objeto Twenty `roleplaySessoes` (createOne):
//   nome (TEXT) . consultor (SELECT) . persona (SELECT) . modalidade (SELECT)
//   status (SELECT) . scoreGeral (NUMBER) . notaDiscovery/Crosssell/Objecoes/
//   Credibilidade/Escalacao/Fechamento (NUMBER) . resumo (TEXT) .
//   pontosFortes (TEXT) . gaps (TEXT) . coaching (TEXT) . transcript (TEXT) .
//   sessaoLocalId (TEXT) . realizadoEm (DATE_TIME)

const store = require('./store');
const personas = require('./personas');

const BASE = (process.env.TWENTY_REST_URL || 'https://crm.meulucroativo.seg.br/rest').replace(/\/$/, '');
const TOKEN = process.env.TWENTY_API_KEY || '';

function bullets(arr) {
  return Array.isArray(arr) && arr.length ? arr.map((x) => `• ${x}`).join('\n') : '';
}

// consultor e modalidade são campos SELECT no Twenty: gravar o value da opção (UPPER_SNAKE_CASE).
// Consultores conhecidos = opções cadastradas no CRM; nome fora da lista cai em OUTRO pra o sync
// nunca quebrar (o gestor reclassifica ou eu adiciono a opção depois).
const CONSULTORES_CONHECIDOS = new Set(['GUILHERME', 'GABRIEL', 'ADRIEL', 'TESTE_DIEGO']);
const MODALIDADES_VALIDAS = new Set(['R1', 'FOLLOWUP', 'FECHAMENTO', 'TECNICA']);

function enumValue(str) {
  return String(str || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function consultorOption(nome) {
  const v = enumValue(nome);
  return CONSULTORES_CONHECIDOS.has(v) ? v : 'OUTRO';
}

function modalidadeOption(mod) {
  const v = enumValue(mod);
  return MODALIDADES_VALIDAS.has(v) ? v : 'R1';
}

async function sync(sessaoId) {
  if (!TOKEN) return { ok: false, error: 'TWENTY_API_KEY ausente — sync CRM pulado' };
  const s = store.carregar(sessaoId);
  if (!s) return { ok: false, error: `sessão '${sessaoId}' não encontrada` };
  if (!s.avaliacao) return { ok: false, error: 'sessão ainda não avaliada — nada a sincronizar' };

  const persona = personas.getPersona(s.personaId);
  const a = s.avaliacao;
  const n = a.notas || {};

  // Calibragem 2026-08-16: dois eixos. Como o objeto roleplaySessoes ainda não tem
  // campos dedicados, deixo execução/aproveitamento explícitos no topo do resumo e
  // a lista de sinais detectados nos gaps — visível pro gestor sem alterar o schema.
  const aprovTxt = a.crosssellAplicavel ? `${a.scoreAproveitamento}` : 'N/A (cliente não abriu porta)';
  const cabecalho = `[Execução ${a.scoreExecucao ?? '—'} · Aproveitamento ${aprovTxt} · Geral ${a.scoreGeral}]`;
  const resumoFull = [cabecalho, a.resumo || ''].filter(Boolean).join('\n');
  const sinaisBullets = Array.isArray(a.sinaisDetectados) && a.sinaisDetectados.length
    ? a.sinaisDetectados.map((x) => `• [${x.aproveitado ? 'aproveitado' : 'PERDIDO'}] ${x.sinal}: "${x.trecho}"`).join('\n')
    : '';
  const gapsFull = [bullets(a.gaps), sinaisBullets && `Sinais do cliente:\n${sinaisBullets}`].filter(Boolean).join('\n');

  const payload = {
    name: `Role-play ${persona ? persona.nome : s.personaId} — ${s.consultor} (${a.scoreGeral})`,
    // consultor, modalidade, persona e status são campos SELECT no Twenty: gravar o value da opção (UPPER_SNAKE_CASE), não o rótulo
    consultor: consultorOption(s.consultor),
    persona: enumValue(persona ? persona.id : s.personaId),
    modalidade: modalidadeOption(s.modalidade),
    status: enumValue(s.status),
    scoreGeral: a.scoreGeral,
    notaDiscovery: Number(n.discovery) || 0,
    notaCrosssell: Number(n.crosssell) || 0,
    notaObjecoes: Number(n.objecoes) || 0,
    notaCredibilidade: Number(n.credibilidade) || 0,
    notaEscalacao: Number(n.escalacao) || 0,
    notaFechamento: Number(n.fechamento) || 0,
    resumo: resumoFull,
    pontosFortes: bullets(a.pontosFortes),
    gaps: gapsFull,
    coaching: bullets(a.coaching),
    transcript: store.transcriptTexto(s).slice(0, 60000),
    sessaoLocalId: s.id,
    realizadoEm: s.criadoEm,
  };

  try {
    const resp = await fetch(`${BASE}/roleplaySessoes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, error: `Twenty respondeu ${resp.status}`, detalhe: JSON.stringify(body).slice(0, 400) };
    }
    const recordId = body?.data?.createRoleplaySesso?.id || body?.data?.id || null;
    if (recordId) { s.crmRecordId = recordId; store.salvar(s); }
    return { ok: true, recordId };
  } catch (err) {
    return { ok: false, error: `falha de rede no sync CRM: ${err.message}` };
  }
}

module.exports = { sync };
