// Hiperagente Avaliador.
//
// Lê o transcript completo de uma sessão encerrada e pontua o CONSULTOR pela rubrica
// derivada do Playbook Comercial + padrões de coaching da Lucro Ativo. Devolve nota
// por métrica (0-10), nota geral ponderada, pontos fortes, gaps e coaching específico
// com trechos citados. Saída em JSON estruturado pra virar registro no CRM.

const { query } = require('../../claude-query');
const personas = require('./personas');
const store = require('./store');

// ============================================================================
// RUBRICA — dois eixos separados (calibragem 2026-08-16, decidida com o Dr. Lucas).
//
// Motivo: a régua antiga media a reunião contra um IDEAL abstrato ("vendedor perfeito
// puxa todas as frentes") e punia o consultor pela NATUREZA do lead. Um cliente que
// chega cercado ("só quero o DCF") derrubava a nota de cross-sell com o mesmo peso de
// um lead aberto — injusto. A separação abaixo mede duas verdades independentes:
//
//   EIXO A — EXECUÇÃO: conduziu bem o que estava NA MESA? (sempre aplicável)
//   EIXO B — APROVEITAMENTO: expandiu o teto da oportunidade? (só conta se o cliente
//            EMITIU sinal; cross-sell é CONDICIONAL AO SINAL, nunca a uma expectativa fixa)
//
// Regra de ouro do cross-sell:
//   - cliente não abriu nenhuma porta  -> aproveitamento N/A (neutro, não penaliza)
//   - abriu porta e o consultor atravessou -> nota alta
//   - abriu porta e foi ignorada -> penaliza (o erro caro dos 83%)
// ============================================================================

// Eixo A — pesos internos somam 100. Vira scoreExecucao.
const RUBRICA_EXECUCAO = [
  { chave: 'discovery', nome: 'Discovery / descoberta de dor (SPIN)', peso: 22,
    guia: 'Diagnosticou a dor ANTES de vender? Ou rodou pitch enlatado? Discovery curto e pitch de 80% da reunião = nota baixa.' },
  { chave: 'objecoes', nome: 'Tratamento de objeções', peso: 20,
    guia: 'Tratou objeções de forma proativa e honesta, com garantias documentais (apólice, homologação, responsabilidade civil)? Ficou na defensiva ou usou analogia fraca?' },
  { chave: 'credibilidade', nome: 'Credibilidade técnica', peso: 30,
    guia: 'Precisão técnica sem erro. PENALIZE FORTE promessas sem respaldo, números incompatíveis na mesma resposta (ex: "45% de exposição" e logo "5%"), "seguro é garantia total", "único escritório do Brasil".' },
  { chave: 'escalacao', nome: 'Gatilho de escalação', peso: 10,
    guia: 'Reconheceu quando o interlocutor o superou tecnicamente e escalou pro Dr. Lucas em vez de blefar? Defender o que não domina = nota baixa.' },
  { chave: 'fechamento', nome: 'Condução e fechamento', peso: 18,
    guia: 'Fechou com próximo passo concreto e datado (NDA, CNPJ, reunião técnica)? Devolveu a iniciativa pro cliente ("vai avisando se precisar") = nota baixa. Urgência artificial também penaliza.' },
];

// Eixo B — nota única, condicional ao sinal. Vira scoreAproveitamento (ou null se N/A).
const RUBRICA_APROVEITAMENTO = {
  chave: 'crosssell', nome: 'Aproveitamento / cross-sell (2ª linha)',
  guia: 'Mede SÓ contra os sinais que o cliente EMITIU (portas abertas pela boca dele: menção a regime tributário, sazonalidade, origem financeira, reforma, outra dor). ' +
        'Atravessou o sinal = alto. Ignorou sinal entregue de graça = baixo (erro dos 83%). ' +
        'IMPORTANTE: se o cliente NÃO abriu porta nenhuma, isto é N/A — não invente teto, não penalize.' };

// Peso do eixo aproveitamento na nota geral QUANDO ele é aplicável (há sinal).
// Execução carrega o resto. Calibrado pra bater o faro do Dr. Lucas no caso Cia Toy
// (execução B+ ~8,0 + aproveitamento C ~5,0 -> geral B ~7,0).
const PESO_APROVEITAMENTO = 0.35;

// Compat: exportado como RUBRICA (lista achatada) pra quem consumia o módulo antes.
const RUBRICA = [
  ...RUBRICA_EXECUCAO,
  { chave: RUBRICA_APROVEITAMENTO.chave, nome: RUBRICA_APROVEITAMENTO.nome, peso: null, guia: RUBRICA_APROVEITAMENTO.guia },
];

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('');
  }
  if (content.text) return content.text;
  return '';
}

function parseJsonSolto(txt) {
  if (!txt) return null;
  // Tenta bloco ```json ... ``` primeiro, depois primeiro {...} balanceado.
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidato = fence ? fence[1] : txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidato);
  } catch (_) {
    return null;
  }
}

// Pura e testável: recebe o JSON do avaliador e devolve os dois eixos + nota geral.
// Regra: cross-sell é CONDICIONAL AO SINAL. Sem porta aberta pelo cliente => aproveitamento
// N/A (não penaliza), e a geral vira a própria execução.
function calcularScores(parsed) {
  const round1 = (x) => Math.round(x * 10) / 10;
  const notas = (parsed && parsed.notas) || {};

  // EIXO A — Execução: média ponderada dos 5 itens (sempre aplicável).
  let somaExec = 0, pesoExec = 0;
  for (const r of RUBRICA_EXECUCAO) {
    const n = Number(notas[r.chave]);
    if (!Number.isNaN(n)) { somaExec += n * r.peso; pesoExec += r.peso; }
  }
  const scoreExecucao = pesoExec ? round1(somaExec / pesoExec) : null;

  // EIXO B — Aproveitamento: só aplicável se há ao menos um sinal detectado.
  const sinais = Array.isArray(parsed && parsed.sinaisDetectados) ? parsed.sinaisDetectados : [];
  const notaCross = notas.crosssell;
  const crosssellAplicavel =
    (parsed && parsed.crosssellAplicavel === true) ||
    (!(parsed && parsed.crosssellAplicavel === false) && sinais.length > 0);
  const scoreAproveitamento =
    crosssellAplicavel && notaCross != null && !Number.isNaN(Number(notaCross))
      ? round1(Number(notaCross))
      : null;

  // NOTA GERAL — execução carrega; aproveitamento só pesa quando há sinal.
  let scoreGeral;
  if (scoreExecucao == null) {
    scoreGeral = scoreAproveitamento;
  } else if (scoreAproveitamento == null) {
    scoreGeral = scoreExecucao; // lead cercado: protege o consultor
  } else {
    scoreGeral = round1(scoreExecucao * (1 - PESO_APROVEITAMENTO) + scoreAproveitamento * PESO_APROVEITAMENTO);
  }

  return { scoreExecucao, scoreAproveitamento, crosssellAplicavel, scoreGeral, sinais };
}

async function avaliar({ sessaoId, timeoutMs = 180000 }) {
  const sessao = store.carregar(sessaoId);
  if (!sessao) return { ok: false, error: `sessão '${sessaoId}' não encontrada` };
  if (sessao.turnos.filter((t) => t.autor === 'consultor').length === 0) {
    return { ok: false, error: 'sessão sem falas do consultor — nada a avaliar' };
  }

  const persona = personas.getPersona(sessao.personaId);
  const transcript = store.transcriptTexto(sessao);
  const execTxt = RUBRICA_EXECUCAO.map((r) => `- ${r.chave} (peso ${r.peso}) — ${r.nome}: ${r.guia}`).join('\n');
  const briefingTxt = sessao.briefing
    ? sessao.briefing
    : '(não informado — infira do próprio transcript o que o cliente veio buscar antes de julgar aproveitamento)';

  const systemAval =
    'Você é o Hiperagente Avaliador de treinamento comercial da Lucro Ativo, um advogado ' +
    'tributarista sênior e gestor comercial rigoroso, justo e específico. Avalia o CONSULTOR ' +
    '(vendedor), NUNCA o lead. Baseie cada nota em trechos concretos do transcript. Você mede ' +
    'DUAS coisas separadas: EXECUÇÃO (conduziu bem o que estava na mesa) e APROVEITAMENTO ' +
    '(expandiu o teto da oportunidade). Nunca contamine uma com a outra.';

  const prompt = `Avalie o desempenho do CONSULTOR nesta simulação de reunião comercial.

PERSONA DO LEAD: ${persona.nome}
CRITÉRIO DE SUCESSO COM ESSA PERSONA: ${persona.criterioFechamento}
MODALIDADE: ${sessao.modalidade}

BRIEFING / INTENÇÃO DO CLIENTE (o que ele veio buscar — é o DENOMINADOR da avaliação):
${briefingTxt}

TRANSCRIPT:
${transcript}

COMO AVALIAR — dois eixos separados:

EIXO A — EXECUÇÃO (o que estava na mesa). Pontue cada item de 0 a 10:
${execTxt}

EIXO B — APROVEITAMENTO / CROSS-SELL (condicional ao sinal):
${RUBRICA_APROVEITAMENTO.guia}
Passo obrigatório: ANTES de dar a nota de cross-sell, liste em "sinaisDetectados" cada
PORTA que o cliente abriu com a própria boca (cite o trecho literal do CLIENTE) e marque
se o consultor a atravessou ("aproveitado": true/false). A nota de cross-sell tem que ser
consequência dessa lista — não um chute. Se a lista vier vazia (cliente genuinamente cercado,
não abriu porta), então "crosssellAplicavel": false e "notas.crosssell": null.

Responda APENAS com um JSON válido, sem texto fora dele, neste formato exato:
{
  "sinaisDetectados": [{ "sinal": "frente/dor sugerida (ex: Financeira, Corporativa/reforma, sazonalidade)", "trecho": "citação LITERAL do cliente", "aproveitado": true|false }],
  "crosssellAplicavel": true|false,
  "notas": { "discovery": <0-10>, "objecoes": <0-10>, "credibilidade": <0-10>, "escalacao": <0-10>, "fechamento": <0-10>, "crosssell": <0-10 ou null se não aplicável> },
  "pontosFortes": ["...", "..."],
  "gaps": ["...", "..."],
  "coaching": ["ação específica 1", "ação específica 2"],
  "trechosChave": [{ "trecho": "citação literal do consultor", "comentario": "por que foi bom/ruim" }],
  "vereditoPersona": "se o consultor teria 'ganhado' essa persona (fechado o próximo passo) e por quê",
  "resumo": "2-3 frases de síntese, distinguindo execução de aproveitamento"
}`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  let assistantText = '';
  let resultEvent = null;
  try {
    for await (const msg of query({
      prompt,
      options: { maxTurns: 1, permissionMode: 'bypassPermissions', allowedTools: [], appendSystemPrompt: systemAval, abortController },
    })) {
      if (msg.type === 'assistant' && msg.message && msg.message.content) assistantText += extractText(msg.message.content);
      if (msg.type === 'result') { resultEvent = msg; break; }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const bruto = (resultEvent && typeof resultEvent.result === 'string' ? resultEvent.result : '') || assistantText;
  const parsed = parseJsonSolto(bruto);
  if (!parsed || !parsed.notas) {
    return { ok: false, error: 'avaliador não retornou JSON válido', bruto: (bruto || '').slice(0, 800) };
  }

  const { scoreExecucao, scoreAproveitamento, crosssellAplicavel, scoreGeral, sinais } = calcularScores(parsed);
  // Normaliza a nota do cross-sell (null quando N/A) pra não contaminar o resto.
  if (!crosssellAplicavel && parsed.notas) parsed.notas.crosssell = null;

  const avaliacao = {
    scoreGeral,
    scoreExecucao,
    scoreAproveitamento, // null = N/A (cliente não abriu porta)
    crosssellAplicavel,
    sinaisDetectados: sinais,
    notas: parsed.notas,
    pontosFortes: parsed.pontosFortes || [],
    gaps: parsed.gaps || [],
    coaching: parsed.coaching || [],
    trechosChave: parsed.trechosChave || [],
    vereditoPersona: parsed.vereditoPersona || '',
    resumo: parsed.resumo || '',
    rubrica: {
      execucao: RUBRICA_EXECUCAO.map((r) => ({ chave: r.chave, nome: r.nome, peso: r.peso })),
      aproveitamento: { chave: RUBRICA_APROVEITAMENTO.chave, nome: RUBRICA_APROVEITAMENTO.nome, condicionalAoSinal: true },
      pesoAproveitamento: PESO_APROVEITAMENTO,
    },
    avaliadoEm: new Date().toISOString(),
    custoUsd: resultEvent ? resultEvent.total_cost_usd || 0 : 0,
  };

  sessao.avaliacao = avaliacao;
  sessao.status = 'avaliada';
  store.salvar(sessao);

  // Best-effort: grava no Twenty. Se o objeto roleplay_sessoes ainda não existir
  // (ou faltar token), não derruba a avaliação — fica salvo localmente.
  let crmSync = null;
  try {
    crmSync = await require('./crm-sync').sync(sessaoId);
  } catch (err) {
    crmSync = { ok: false, error: err.message };
  }

  return { ok: true, sessaoId, scoreGeral, scoreExecucao, scoreAproveitamento, avaliacao, crmSync };
}

module.exports = { avaliar, RUBRICA, RUBRICA_EXECUCAO, RUBRICA_APROVEITAMENTO, PESO_APROVEITAMENTO };
