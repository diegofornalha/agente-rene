// Pipeline @divida <cnpj> — Regularizacao Tributaria + Direito Creditorio Federal
//
// Fluxo:
//   1. @divida <cnpj> → cria caso, pede CSV do Regularize
//   2. CSV chega → parser deterministico (Stage 2)
//   3. Classificacao prescricao (Stage 3)
//   4. Enquadramento transacao (Stage 4)
//   5. Modulo DC (Stage 5)
//   6. Mapeamento judicial (Stage 6)
//   7. Motor economico 2 camadas (Stage 7)
//   8. Gera prompt consolidado pro Claude renderizar docs (Stage 8-10)
//
// Baseado no PLAYBOOK v0.3 — playbook-automacao/

const path = require('path');
const fs = require('fs-extra');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CASES_DIR = path.join(DATA_DIR, 'divida-ativa-cases');

// ── CNPJ utils ──

function normalizeCnpj(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length !== 14) return null;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function cnpjDigits(cnpj) {
  return String(cnpj).replace(/\D/g, '');
}

// ── Case management ──

async function createCase(cnpj, operador) {
  await fs.ensureDir(CASES_DIR);
  const digits = cnpjDigits(cnpj);
  const caseId = `${digits.slice(-4)}`;
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const caseObj = {
    id: `LA-CASE-2026-${caseId}`,
    cnpj: normalizeCnpj(cnpj) || cnpj,
    cnpj_digits: digits,
    case_id: caseId,
    created_at: new Date().toISOString(),
    operador: operador || 'sistema',
    status: 'aguardando_csv',
    // Stage 0 — preenchido pelo operador depois
    cliente: null,
    responsavel_tecnico: 'OAB/SP 330.144',
    oab_sociedade: '40.789',
    honorario: null, // {entrada, n_parcelas, valor_parcela}
    inicio_pagamento: 'assinatura',
    // Outputs dos stages
    ledger: null,
    prescricao: null,
    transacao: null,
    dc: null,
    judicial: null,
    economico: null,
  };

  const casePath = path.join(CASES_DIR, `${digits}.json`);
  await fs.writeJson(casePath, caseObj, { spaces: 2 });
  return caseObj;
}

async function getCase(cnpj) {
  const digits = cnpjDigits(cnpj);
  const casePath = path.join(CASES_DIR, `${digits}.json`);
  if (!await fs.pathExists(casePath)) return null;
  return fs.readJson(casePath);
}

async function updateCase(cnpj, updates) {
  const digits = cnpjDigits(cnpj);
  const casePath = path.join(CASES_DIR, `${digits}.json`);
  const existing = await fs.readJson(casePath);
  const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
  await fs.writeJson(casePath, updated, { spaces: 2 });
  return updated;
}

// ── Stage 2 — Parser CSV do Regularize ──

function parseRegularizeCsv(csvText) {
  const lines = csvText.split(/\r?\n/);

  // Acha linha de cabecalho
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^Inscri[çc][aã]o[;\t]/i.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new Error('CSV do Regularize: cabeçalho "Inscrição;..." não encontrado');
  }

  // Extrair devedor do preambulo
  let devedor = null;
  for (let i = 0; i < headerIdx; i++) {
    const m = lines[i].match(/Devedor:\s*(.+?)(?:\s*;\s*CPF|$)/i);
    if (m) { devedor = m[1].trim(); break; }
  }

  const headers = lines[headerIdx].split(';').map(h => h.trim());
  const colMap = {};
  headers.forEach((h, i) => {
    const key = h.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (key.includes('inscricao') && !key.includes('natureza') && !key.includes('situacao') && !key.includes('data')) colMap.inscricao = i;
    else if (key.includes('valor total')) colMap.valor = i;
    else if (key.includes('natureza')) colMap.natureza = i;
    else if (key.includes('situacao')) colMap.situacao = i;
    else if (key.includes('data da inscricao') || key.includes('data inscricao')) colMap.data = i;
    else if (key.includes('nome devedor')) colMap.devedor = i;
    else if (key.includes('cpf') || key.includes('cnpj devedor')) colMap.cnpj = i;
    else if (key.includes('processo administrativo')) colMap.proc_adm = i;
    else if (key.includes('numero unico') || key.includes('processo judicial')) colMap.proc_judicial = i;
    else if (key.includes('pfn')) colMap.pfn = i;
  });

  function parseValor(s) {
    if (!s) return 0;
    return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
  }

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(';');
    if (cols.length < 4) continue;

    const situacao = (cols[colMap.situacao] || '').trim().toUpperCase();
    const valor = parseValor(cols[colMap.valor]);
    const procJudicial = (cols[colMap.proc_judicial] || '').trim();

    let classificacao;
    if (situacao.includes('EXTINTA')) {
      classificacao = 'extinta';
    } else if (/NEGOCIAD/.test(situacao)) {
      classificacao = 'sispar';
    } else if (situacao.startsWith('ATIVA')) {
      classificacao = 'ativa';
    } else {
      classificacao = 'outra';
    }

    rows.push({
      inscricao: (cols[colMap.inscricao] || '').trim(),
      valor,
      natureza: (cols[colMap.natureza] || '').trim(),
      situacao: situacao,
      classificacao,
      data_inscricao: (cols[colMap.data] || '').trim(),
      proc_administrativo: (cols[colMap.proc_adm] || '').trim(),
      proc_judicial: procJudicial,
      pfn: (cols[colMap.pfn] || '').trim(),
    });
  }

  // Classificar
  const ativas = rows.filter(r => r.classificacao === 'ativa');
  const sispar = rows.filter(r => r.classificacao === 'sispar');
  const extintas = rows.filter(r => r.classificacao === 'extinta');
  const outras = rows.filter(r => r.classificacao === 'outra');

  const totalVivo = rows.filter(r => r.classificacao !== 'extinta').reduce((s, r) => s + r.valor, 0);
  const totalAtivas = ativas.reduce((s, r) => s + r.valor, 0);
  const totalSispar = sispar.reduce((s, r) => s + r.valor, 0);

  // Execucoes fiscais — agrupar por proc_judicial
  const execMap = new Map();
  for (const r of rows) {
    if (r.classificacao === 'extinta') continue;
    if (!r.proc_judicial || r.proc_judicial === '-' || r.proc_judicial === '') continue;
    if (!execMap.has(r.proc_judicial)) {
      // Detectar TRF
      let trf = null;
      const trfMatch = r.proc_judicial.match(/\.4\.0(\d)\./);
      if (trfMatch) trf = `TRF${trfMatch[1]}`;
      execMap.set(r.proc_judicial, { processo: r.proc_judicial, trf, valor: 0, inscricoes: [] });
    }
    const exec = execMap.get(r.proc_judicial);
    exec.valor += r.valor;
    exec.inscricoes.push(r.inscricao);
  }
  const execucoes = [...execMap.values()];

  // Nao ajuizadas = vivas sem processo judicial
  const naoAjuizadas = rows.filter(r =>
    r.classificacao !== 'extinta' &&
    (!r.proc_judicial || r.proc_judicial === '-' || r.proc_judicial === '')
  );

  // Faixa de datas
  const datas = rows.filter(r => r.data_inscricao).map(r => r.data_inscricao).sort();

  return {
    devedor,
    total_inscricoes: rows.length,
    total_vivo: totalVivo,
    total_ativas: totalAtivas,
    total_sispar: totalSispar,
    total_extintas: extintas.reduce((s, r) => s + r.valor, 0),
    ativas,
    sispar,
    extintas,
    outras,
    execucoes,
    nao_ajuizadas: naoAjuizadas,
    faixa_datas: datas.length ? { inicio: datas[0], fim: datas[datas.length - 1] } : null,
    // Validacao cruzada
    reconciliado: Math.abs((totalAtivas + totalSispar + outras.reduce((s, r) => s + r.valor, 0) + naoAjuizadas.filter(r => r.classificacao === 'ativa').reduce((s, r) => s + r.valor, 0)) - totalVivo) < 1,
  };
}

// ── Stage 3 — Triagem de prescricao ──

function triagemPrescricao(ledger) {
  const candidatas = [];
  const agora = new Date();

  for (const exec of ledger.execucoes) {
    // Simplificado: marca como candidata se inscricoes > 5 anos
    for (const insc of exec.inscricoes) {
      const row = ledger.ativas.find(r => r.inscricao === insc) || ledger.sispar.find(r => r.inscricao === insc);
      if (!row) continue;
      const dataInsc = _parseDate(row.data_inscricao);
      if (dataInsc) {
        const anosDesdeInscricao = (agora - dataInsc) / (365.25 * 24 * 60 * 60 * 1000);
        if (anosDesdeInscricao > 6) {
          candidatas.push({
            inscricao: insc,
            processo: exec.processo,
            data_inscricao: row.data_inscricao,
            anos: Math.round(anosDesdeInscricao * 10) / 10,
            tipo: 'intercorrente_judicial',
            nota: 'Verificar suspensão art. 40 LEF + Súmula 314/STJ ★',
          });
        }
      }
    }
  }

  // Carteira recente?
  const dominante = candidatas.length > (ledger.ativas.length * 0.5);

  return {
    dominante,
    candidatas,
    observacoes: dominante
      ? ['Prescrição intercorrente é tese relevante nesta carteira.']
      : ['Carteira relativamente recente — prescrição não é o eixo principal. Verificar PAs antigos pontualmente ★.'],
  };
}

function _parseDate(s) {
  if (!s) return null;
  // DD/MM/YYYY
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  // YYYY-MM-DD
  const m2 = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  return null;
}

// ── Stage 4 — Enquadramento transacao ──

function enquadrarTransacao(ledger) {
  const totalVivo = ledger.total_vivo;

  // Edital vigente: PGDAU 6/2026 (atualizar a cada caso)
  const edital = {
    nome: 'PGDAU nº 6/2026',
    adesao_ate: '2026-09-30',
    inscritos_ate: '2026-03-03',
    consolidado_max: 45_000_000,
  };

  const elegivel = totalVivo <= edital.consolidado_max;

  // Modalidade por faixa
  let modalidade;
  if (totalVivo <= 1_000_000) {
    modalidade = 'pequeno_valor';
  } else if (totalVivo <= 10_000_000) {
    modalidade = 'individual_simplificada';
  } else {
    modalidade = 'capacidade_pagamento';
  }

  // Gate SISPAR
  const sisparDecisao = ledger.sispar.map(r => ({
    inscricao: r.inscricao,
    valor: r.valor,
    decisao: 'avaliar', // ★ decisao caso a caso
    nota: 'Rescisão prévia do parcelamento necessária para migrar à transação ★',
  }));

  return {
    edital,
    elegivel,
    modalidade,
    desconto_estimado: 'Até 65% sobre juros/multa/encargos (principal intacto) ★',
    sispar_decisao: sisparDecisao,
    elegivel_dc: modalidade === 'capacidade_pagamento' || modalidade === 'individual_simplificada',
    nota_elegibilidade_dc: modalidade === 'pequeno_valor'
      ? 'Verificar se modalidade de pequeno valor admite amortização por precatório ★'
      : null,
  };
}

// ── Stage 5 — Modulo DC ──

function moduloDC(ledger, transacao) {
  const quitaAte = ledger.total_vivo * 0.50;

  return {
    base_legal: 'art. 11, V, Lei 13.988/2020 + Portaria PGFN 10.826/2022 + art. 100, §11, CF',
    rota: 'transacao_art100_11', // NUNCA DCOMP
    quita_ate: quitaAte,
    quita_ate_fmt: _formatBRL(quitaAte),
    teto: '50% do consolidado — potencial, condicionado à transação obtida ★',
    checklist: {
      origem: 'Precatório federal (próprio ou adquirido de terceiro) ★',
      transito_julgado: 'Verificar ★',
      cessao_integra: 'Escritura pública (RTD) ★',
      valor_face: 'A definir ★',
      desagio: 'A definir ★',
      condicao_resolutoria: true,
    },
    elegivel: transacao.elegivel_dc,
  };
}

// ── Stage 6 — Mapeamento judicial ──

function mapeamentoJudicial(ledger) {
  return {
    execucoes: ledger.execucoes,
    total_execucoes: ledger.execucoes.length,
    efeito: 'Formalização → suspensão automática; quitação final → extinção (art. 156 CTN)',
    gate_desistencia: 'Desistência de ações/embargos/recursos em 60 dias (art. 784, III, CPC)',
    gate_inadimplencia: '3 prestações (consecutivas ou alternadas) → rescisão + vedação 2 anos',
    a_desistir: ledger.execucoes.map(e => ({
      processo: e.processo,
      trf: e.trf,
      nota: 'Listar embargos/recursos pendentes ★',
    })),
  };
}

// ── Stage 7 — Motor economico ──

function motorEconomico(ledger, transacao, dc, honorario) {
  const result = {
    bloco_a: {
      descricao: 'Desconto da transação (Fisco) sobre juros/multa/encargos',
      base: ledger.total_vivo,
      base_fmt: _formatBRL(ledger.total_vivo),
      desconto: transacao.desconto_estimado,
      saldo_transacionado: 'A calcular com CAPAG ★',
      indexador: 'Selic',
    },
    bloco_b: {
      descricao: 'Redução por Direito Creditório (potencial)',
      reducao_max: dc.quita_ate,
      reducao_max_fmt: dc.quita_ate_fmt,
      nota: 'Pode atingir até 50% do consolidado, a depender da transação obtida ★',
    },
    bloco_c: {
      descricao: 'Honorário (preço do DC pago à Lucro Ativo)',
      estrutura: null,
      total: null,
      total_fmt: null,
      nota: 'Pendente — operador precisa informar {entrada, n_parcelas, valor_parcela}',
    },
  };

  if (honorario) {
    const { entrada, n_parcelas, valor_parcela } = honorario;
    const total = entrada + n_parcelas * valor_parcela;
    result.bloco_c = {
      descricao: 'Honorário (preço do DC pago à Lucro Ativo)',
      estrutura: honorario,
      entrada_fmt: _formatBRL(entrada),
      parcelas: `${n_parcelas}× ${_formatBRL(valor_parcela)}`,
      total,
      total_fmt: _formatBRL(total),
      nota: null,
    };
  }

  return result;
}

// ── Format helpers ──

function _formatBRL(v) {
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Stage 8-10 — Monta prompt consolidado pro Claude gerar docs ──

function buildDocPrompt(caseObj) {
  const { ledger, prescricao, transacao, dc, judicial, economico } = caseObj;

  return `Gere os 4 entregáveis MID-01 para o caso ${caseObj.id} (${caseObj.cnpj}):

## Dados do caso
- Cliente: ${caseObj.cliente || ledger.devedor || caseObj.cnpj}
- CNPJ: ${caseObj.cnpj}
- Consolidado vivo: ${_formatBRL(ledger.total_vivo)}
- Inscrições: ${ledger.total_inscricoes} total (${ledger.ativas.length} ativas, ${ledger.sispar.length} SISPAR, ${ledger.extintas.length} extintas)
- Execuções fiscais: ${ledger.execucoes.length}
- Não ajuizadas: ${ledger.nao_ajuizadas.length}
${ledger.faixa_datas ? `- Período: ${ledger.faixa_datas.inicio} a ${ledger.faixa_datas.fim}` : ''}

## Prescrição
- Dominante: ${prescricao.dominante ? 'Sim' : 'Não'}
- Candidatas: ${prescricao.candidatas.length}
${prescricao.observacoes.map(o => `- ${o}`).join('\n')}

## Transação
- Edital: ${transacao.edital.nome} (adesão até ${transacao.edital.adesao_ate})
- Elegível: ${transacao.elegivel ? 'Sim' : 'Não'}
- Modalidade: ${transacao.modalidade}
- Desconto estimado: ${transacao.desconto_estimado}
- SISPAR (${transacao.sispar_decisao.length} inscrições): ${transacao.sispar_decisao.length > 0 ? 'rescisão prévia necessária ★' : 'N/A'}
- DC elegível: ${transacao.elegivel_dc ? 'Sim ★' : 'Verificar ★'}

## Direito Creditório
- Quita até: ${dc.quita_ate_fmt} (${dc.teto})
- Base legal: ${dc.base_legal}
- Rota: transação/art. 100, §11 (NUNCA DCOMP)

## Efeito judicial
- ${judicial.total_execucoes} execuções → suspensão automática na formalização → extinção na quitação
- Gate desistência: 60 dias
- Gate inadimplência: 3 prestações → rescisão + vedação 2 anos

## Motor econômico
- Bloco A: ${economico.bloco_a.base_fmt} — ${economico.bloco_a.desconto}
- Bloco B: até ${economico.bloco_b.reducao_max_fmt} — pode atingir até 50%, a depender da transação obtida ★
- Bloco C: ${economico.bloco_c.total_fmt || economico.bloco_c.nota}

## Instruções de geração
1. **Diagnóstico** (LA-DIAG-2026-${caseObj.case_id}): panorama, KPIs, tabelas ativas × SISPAR, execuções, triagem prescrição, estratégia 2 camadas, dados consolidados.
2. **Parecer Técnico-Jurídico** (LA-PARECER-2026-${caseObj.case_id}): referências legais, objeto (3 conclusões), fatos, análise (prescrição, transação, DC ≤50%, efeito execuções, trava SISPAR, fluxograma), conclusão, sigilo art. 7º II Lei 8.906/94.
3. **Proposta de Trabalho** (LA-PROP-2026-${caseObj.case_id}): contexto, objeto, metodologia, modelo financeiro, condições, próximos passos.
4. **Cartilha do Cliente**: linguagem leiga, "em uma frase", quanto está em jogo, 2 camadas, efeito nos processos, risco, custo, resumo honesto, prevalência do parecer.

## GUARDRAILS (bloqueante)
- NUNCA prometer % fixo de redução. Sempre: "pode atingir até 50%, a depender da transação obtida"
- NUNCA rotear DC por DCOMP/compensação ordinária
- Se há SISPAR, OBRIGATÓRIO mencionar rescisão prévia
- Se há execuções, OBRIGATÓRIO mencionar suspensão→extinção + desistência 60 dias
- Todo ★ = estimativa/verificação pendente
- Principal NÃO reduz na transação (art. 11, §2º, I, Lei 13.988/2020)`;
}

// ── Pipeline principal ──

async function processarCsv(cnpj, csvText) {
  const caseObj = await getCase(cnpj);
  if (!caseObj) throw new Error(`Caso não encontrado para CNPJ ${cnpj}`);

  // Stage 2
  const ledger = parseRegularizeCsv(csvText);

  // Stage 3
  const prescricao = triagemPrescricao(ledger);

  // Stage 4
  const transacao = enquadrarTransacao(ledger);

  // Stage 5
  const dc = moduloDC(ledger, transacao);

  // Stage 6
  const judicial = mapeamentoJudicial(ledger);

  // Stage 7
  const economico = motorEconomico(ledger, transacao, dc, caseObj.honorario);

  // Atualiza caso
  const updated = await updateCase(cnpj, {
    status: 'processado',
    cliente: ledger.devedor || caseObj.cliente,
    ledger,
    prescricao,
    transacao,
    dc,
    judicial,
    economico,
  });

  // Stage 8-10 — prompt pro Claude
  const docPrompt = buildDocPrompt(updated);

  return {
    case: updated,
    resumo: _buildResumo(updated),
    docPrompt,
  };
}

function _buildResumo(caseObj) {
  const l = caseObj.ledger;
  const t = caseObj.transacao;
  const d = caseObj.dc;
  const lines = [
    `📊 **Diagnóstico rápido — ${caseObj.cnpj}**`,
    ``,
    `**Consolidado vivo:** ${_formatBRL(l.total_vivo)}`,
    `**Inscrições:** ${l.total_inscricoes} (${l.ativas.length} ativas, ${l.sispar.length} SISPAR, ${l.extintas.length} extintas)`,
    `**Execuções fiscais:** ${l.execucoes.length}`,
    `**Não ajuizadas:** ${l.nao_ajuizadas.length}`,
    ``,
    `**Transação:** ${t.edital.nome} — modalidade ${t.modalidade}`,
    `**Desconto Fisco:** ${t.desconto_estimado}`,
    `**DC (potencial):** até ${d.quita_ate_fmt} — pode atingir até 50%, a depender da transação obtida ★`,
    ``,
    `**Prescrição:** ${caseObj.prescricao.dominante ? 'tese relevante' : 'não dominante'} (${caseObj.prescricao.candidatas.length} candidatas)`,
  ];

  if (l.sispar.length > 0) {
    lines.push(``, `⚠️ **${l.sispar.length} inscrições no SISPAR** — rescisão prévia necessária pra migrar à transação`);
  }

  if (caseObj.economico.bloco_c.total_fmt) {
    lines.push(``, `**Honorário:** ${caseObj.economico.bloco_c.entrada_fmt} entrada + ${caseObj.economico.bloco_c.parcelas} = ${caseObj.economico.bloco_c.total_fmt}`);
  } else {
    lines.push(``, `⏳ **Honorário:** pendente — informar {entrada, n_parcelas, valor_parcela}`);
  }

  lines.push(``, `Caso ${caseObj.id} — próximo passo: gerar os 4 entregáveis MID-01.`);
  return lines.join('\n');
}

// ── Exports ──

module.exports = {
  normalizeCnpj,
  cnpjDigits,
  createCase,
  getCase,
  updateCase,
  parseRegularizeCsv,
  processarCsv,
  buildDocPrompt,
};
