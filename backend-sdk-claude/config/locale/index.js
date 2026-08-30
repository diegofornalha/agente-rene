// Seleção de locale do agente via env AGENT_LOCALE (default: pt-BR).
// Fallback silencioso pra pt-BR se o locale pedido não existir — nunca
// derruba o boot por locale inválido.
const LOCALE = (process.env.AGENT_LOCALE || 'pt-BR').trim();

let strings;
try {
  strings = require(`./${LOCALE}`);
} catch {
  console.warn(`⚠️ locale "${LOCALE}" não encontrado em config/locale/ — usando pt-BR`);
  strings = require('./pt-BR');
}

module.exports = strings;
