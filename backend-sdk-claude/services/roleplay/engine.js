// Engine de Role-Play (modo IA em texto).
//
// O Hiperagente-Lead interpreta a persona escolhida. Como claude-query é stateless
// (spawna um processo por chamada), reconstruímos o histórico completo no prompt a
// cada turno. Sem MCP e sem ferramentas — é só conversa (allowedTools: []), rápido
// e barato.
//
// Fluxo:
//   iniciar({consultor, personaId, modalidade}) -> cria sessão + fala de abertura do lead
//   responder({sessaoId, mensagem})             -> registra fala do consultor + resposta do lead
//   encerrar({sessaoId})                         -> marca status 'encerrada' (libera avaliação)

const { query } = require('../../claude-query');
const personas = require('./personas');
const store = require('./store');

const MODALIDADES = {
  r1: 'Reunião 1 (primeiro contato / apresentação da solução)',
  followup: 'Follow-up (retomada após o primeiro contato)',
  fechamento: 'Reunião de fechamento (cliente já conhece, hora de decidir)',
  tecnica: 'Reunião técnica (com aprofundamento jurídico/contábil)',
};

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('');
  }
  if (content.text) return content.text;
  return '';
}

// Roda uma query de turno único e devolve o texto final do lead.
async function gerarFalaLead({ persona, modalidade, sessao, instrucao, timeoutMs = 90000 }) {
  const modalidadeDesc = MODALIDADES[modalidade] || MODALIDADES.r1;
  const historico = store.transcriptTexto(sessao);

  const systemLead =
    persona.systemPrompt +
    `\n\nMODALIDADE DA REUNIÃO: ${modalidadeDesc}. Responda SEMPRE só com a fala do lead, ` +
    `em português do Brasil, sem narração, sem aspas, sem prefixo "LEAD:". Mantenha 2-5 frases.`;

  const prompt =
    (historico
      ? `Conversa até agora:\n${historico}\n\n`
      : '') + instrucao;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  let assistantText = '';
  let resultEvent = null;
  try {
    for await (const msg of query({
      prompt,
      options: {
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowedTools: [],
        appendSystemPrompt: systemLead,
        abortController,
      },
    })) {
      if (msg.type === 'assistant' && msg.message && msg.message.content) {
        assistantText += extractText(msg.message.content);
      }
      if (msg.type === 'result') {
        resultEvent = msg;
        break;
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const texto =
    resultEvent && typeof resultEvent.result === 'string' && resultEvent.result.trim()
      ? resultEvent.result.trim()
      : assistantText.trim();
  if (!texto) throw new Error('lead não produziu resposta (timeout ou erro na query)');
  return texto;
}

async function iniciar({ consultor, personaId, modalidade, briefing }) {
  const persona = personas.getPersona(personaId);
  if (!persona) {
    return { ok: false, error: `persona '${personaId}' inexistente. Use: ${personas.listPersonas().map((p) => p.id).join(', ')}` };
  }
  const sessao = store.criar({ consultor, personaId, modalidade, briefing });
  try {
    const abertura = await gerarFalaLead({
      persona,
      modalidade,
      sessao,
      instrucao:
        'A reunião está começando. O CONSULTOR acabou de te cumprimentar. Dê a fala de ' +
        'ABERTURA do lead: apresente-se brevemente (nome, empresa, cargo coerentes com sua ' +
        'persona) e já sinalize seu tom característico. Não facilite.',
    });
    store.addTurno(sessao.id, 'lead', abertura);
    return { ok: true, sessaoId: sessao.id, persona: persona.nome, modalidade: sessao.modalidade, lead: abertura };
  } catch (err) {
    return { ok: false, error: err.message, sessaoId: sessao.id };
  }
}

async function responder({ sessaoId, mensagem }) {
  if (!mensagem || !String(mensagem).trim()) return { ok: false, error: 'mensagem do consultor obrigatória' };
  const sessao = store.carregar(sessaoId);
  if (!sessao) return { ok: false, error: `sessão '${sessaoId}' não encontrada` };
  if (sessao.status !== 'em_andamento') return { ok: false, error: `sessão está '${sessao.status}', não aceita novos turnos` };

  const persona = personas.getPersona(sessao.personaId);
  store.addTurno(sessaoId, 'consultor', String(mensagem).trim());
  const atualizada = store.carregar(sessaoId);

  try {
    const resposta = await gerarFalaLead({
      persona,
      modalidade: sessao.modalidade,
      sessao: atualizada,
      instrucao: 'O CONSULTOR acabou de falar (última linha da conversa). Responda como o lead, no personagem.',
    });
    store.addTurno(sessaoId, 'lead', resposta);
    return { ok: true, sessaoId, lead: resposta, turnos: atualizada.turnos.length + 1 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function encerrar({ sessaoId }) {
  const sessao = store.carregar(sessaoId);
  if (!sessao) return { ok: false, error: `sessão '${sessaoId}' não encontrada` };
  sessao.status = 'encerrada';
  sessao.encerradoEm = new Date().toISOString();
  store.salvar(sessao);
  return { ok: true, sessaoId, status: sessao.status, turnos: sessao.turnos.length };
}

module.exports = { iniciar, responder, encerrar, MODALIDADES };
