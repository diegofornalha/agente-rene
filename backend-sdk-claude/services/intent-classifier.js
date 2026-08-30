// Intent Classifier — detecta se a mensagem do usuário é uma AÇÃO (tarefa a executar)
// ou CONVERSA (precisa de resposta conversacional).
//
// Classificação puramente heurística (sem LLM call), roda em <1ms.
// Quando a intenção é "action", o task-runner recebe maxTurns maior e
// um system prompt instruindo execução silenciosa.

'use strict';

// ── Padrões de ação ──────────────────────────────────────────────────
// Verbos imperativos / frases que indicam "faça algo"
const ACTION_PATTERNS = [
  // Verbos imperativos diretos
  /^(faz|faça|cria|crie|implementa|implemente|manda|mande|envia|envie)\b/i,
  /^(configura|configure|instala|instale|atualiza|atualize|corrige|corrija)\b/i,
  /^(muda|mude|altera|altere|remove|remova|deleta|delete|apaga|apague)\b/i,
  /^(adiciona|adicione|coloca|coloque|seta|sete|roda|rode|executa|execute)\b/i,
  /^(publica|publique|deploya|deploye|builda|builde|testa|teste)\b/i,
  /^(refatora|refatore|otimiza|otimize|migra|migre|renomeia|renomeie)\b/i,
  /^(gera|gere|escreve|escreva|documenta|documente)\b/i,
  /^(para|pare|reinicia|reinicie|restarta|restarte|mata|kill)\b/i,
  /^(verifica|verifique|checa|cheque|analisa|analise|audita|audite)\b/i,

  // "pode criar", "pode fazer", "pode implementar" etc
  /^pode\s+(criar|fazer|implementar|mandar|enviar|configurar|instalar|atualizar|corrigir|mudar|alterar|remover|deletar|adicionar|colocar|rodar|executar|gerar|escrever)/i,

  // "quero que você faça", "preciso que implemente"
  /^(quero|preciso|necessito)\s+que\s+(você\s+)?(faça|crie|implemente|mande|envie|configure|instale|atualize|corrija|mude)/i,

  // "vai lá e faz", "bora criar"
  /^(vai\s+lá\s+e|bora|vamos)\s+(fazer|criar|implementar|configurar)/i,

  // Comandos curtos tipo "pode criar", "manda ver", "toca ficha"
  /^(manda\s+ver|toca\s+ficha|mete\s+bronca|vai\s+fundo|solta\s+o\s+código)/i,

  // "sobe isso", "derruba isso", "liga isso", "desliga isso"
  /^(sobe|derruba|liga|desliga|ativa|desativa|habilita|desabilita)\b/i,
];

// ── Padrões de conversa ──────────────────────────────────────────────
// Greetings, opiniões, perguntas exploratórias, confirmações
const CONVO_PATTERNS = [
  // Saudações
  /^(oi|olá|e\s*aí|fala|salve|bom\s*dia|boa\s*tarde|boa\s*noite|eae)\b/i,

  // Perguntas exploratórias (não é "faça", é "o que acha?")
  /^(o\s+que\s+(você\s+)?acha|como\s+(você\s+)?ve|qual\s+sua\s+opinião)/i,
  /^(me\s+explica|explica\s+pra\s+mim|o\s+que\s+é|como\s+funciona)/i,

  // Confirmações / feedback curto
  /^(ok|beleza|blz|show|top|massa|dahora|valeu|obrigado|tmj|tá\s+bom|entendi|saquei)\b/i,
  /^(sim|não|nope|nop|yes|no|yeah|nah|talvez|depende)\b/i,

  // Opiniões / reflexões
  /^(eu\s+acho|na\s+minha\s+opinião|pra\s+mim|pensando\s+bem)/i,

  // Risadas
  /^(kk+|haha+|rs+|kkk|hehe|huahua)/i,
];

// ── Score boosts por keywords no corpo (não apenas início) ──────────
const ACTION_KEYWORDS = [
  /\b(implementa|deploya|commit|push|merge|PR|pull\s*request)\b/i,
  /\b(código|script|função|endpoint|api|rota|serviço|módulo)\b/i,
  /\b(banco|tabela|migration|schema|model)\b/i,
  /\b(bug|fix|hotfix|patch|erro|crash)\b/i,
  /\b(agora|urgente|já|imediatamente|rápido)\b/i,
];

const CONVO_KEYWORDS = [
  /\b(o\s+que\s+acha|como\s+ve|opinião|ponto\s+de\s+vista)\b/i,
  /\b(obrigado|valeu|agradeço|grato)\b/i,
  /\b(pensando|refletindo|considerando)\b/i,
];

/**
 * Classifica a intenção de uma mensagem.
 *
 * @param {string} text — texto limpo da mensagem (já transcrito se era áudio)
 * @returns {{ intent: 'action'|'conversation', confidence: number, reason: string }}
 */
function classify(text) {
  if (!text || typeof text !== 'string') {
    return { intent: 'conversation', confidence: 0.5, reason: 'empty' };
  }

  const trimmed = text.trim();

  // Mensagens muito curtas (≤3 chars) são quase sempre conversação
  if (trimmed.length <= 3) {
    return { intent: 'conversation', confidence: 0.9, reason: 'ultra-short' };
  }

  let actionScore = 0;
  let convoScore = 0;
  let reason = '';

  // Check padrões de início (mais peso)
  for (const pat of ACTION_PATTERNS) {
    if (pat.test(trimmed)) {
      actionScore += 3;
      reason = `action-pattern: ${pat.source.slice(0, 40)}`;
      break;
    }
  }

  for (const pat of CONVO_PATTERNS) {
    if (pat.test(trimmed)) {
      convoScore += 3;
      if (!reason) reason = `convo-pattern: ${pat.source.slice(0, 40)}`;
      break;
    }
  }

  // Keywords no corpo
  for (const pat of ACTION_KEYWORDS) {
    if (pat.test(trimmed)) actionScore += 1;
  }
  for (const pat of CONVO_KEYWORDS) {
    if (pat.test(trimmed)) convoScore += 1;
  }

  // Heurística: mensagens longas com múltiplos verbos tendem a ser instruções
  if (trimmed.length > 100 && actionScore === 0 && convoScore === 0) {
    // Conta verbos imperativos no corpo inteiro
    const imperativeCount = (trimmed.match(/\b(faz|cria|manda|envia|configura|instala|roda|testa|gera)\b/gi) || []).length;
    if (imperativeCount >= 2) {
      actionScore += 2;
      reason = 'multiple-imperatives';
    }
  }

  // Decide
  const total = actionScore + convoScore || 1;
  if (actionScore > convoScore) {
    return {
      intent: 'action',
      confidence: Math.min(actionScore / total, 0.99),
      reason: reason || 'action-keywords',
    };
  }

  return {
    intent: 'conversation',
    confidence: Math.min(convoScore / total, 0.99),
    reason: reason || (convoScore > 0 ? 'convo-keywords' : 'default-conversation'),
  };
}

// System prompt adicional quando intent === 'action'
const ACTION_SYSTEM_ADDENDUM = `
## Modo Execução (intent: action)
O usuário pediu uma AÇÃO concreta. Seu comportamento muda:
1. NÃO responda conversacionalmente antes de executar. Vá direto à execução.
2. Execute a tarefa usando as ferramentas disponíveis (Bash, Edit, Read, etc.).
3. Só responda ao usuário DEPOIS de concluir a execução, com um resumo curto do que foi feito.
4. Se a tarefa falhar, explique o erro e o que tentou — não peça confirmação, tente resolver.
5. Seja breve no report final: o usuário quer resultado, não explicação.
`.trim();

module.exports = { classify, ACTION_SYSTEM_ADDENDUM };
