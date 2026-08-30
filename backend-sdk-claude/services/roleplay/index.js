// Fachada HTTP do Role-Play Comercial. server.js registra as rotas apontando aqui.
//
// Rotas:
//   GET  /api/roleplay/personas            -> lista personas
//   POST /api/roleplay/start               -> { consultor, personaId, modalidade, briefing? }
//   POST /api/roleplay/turn                -> { sessaoId, mensagem }
//   POST /api/roleplay/end                 -> { sessaoId }
//   POST /api/roleplay/evaluate            -> { sessaoId } (roda o Hiperagente avaliador)
//   GET  /api/roleplay/sessions            -> lista sessões (painel do gestor)
//   GET  /api/roleplay/session/:id         -> detalhe de uma sessão

const personas = require('./personas');
const engine = require('./engine');
const evaluator = require('./evaluator');
const store = require('./store');

module.exports = {
  listPersonas: () => ({ ok: true, personas: personas.listPersonas(), modalidades: engine.MODALIDADES }),
  start: (body) => engine.iniciar(body || {}),
  turn: (body) => engine.responder(body || {}),
  end: (body) => engine.encerrar(body || {}),
  evaluate: (body) => evaluator.avaliar(body || {}),
  listSessions: () => ({ ok: true, sessoes: store.listar() }),
  getSession: (id) => {
    const s = store.carregar(id);
    return s ? { ok: true, sessao: s } : { ok: false, error: `sessão '${id}' não encontrada` };
  },
};
