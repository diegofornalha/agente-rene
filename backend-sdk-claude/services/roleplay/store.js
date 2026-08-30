// Persistência de sessões de role-play em disco (data/roleplay-sessoes/<id>.json).
// MVP local — a sincronização com o Twenty CRM é feita pelo módulo crm-sync.js
// depois que a sessão é avaliada. Cada sessão guarda transcript completo + avaliação.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSOES_DIR = path.join(__dirname, '..', '..', 'data', 'roleplay-sessoes');

function ensureDir() {
  if (!fs.existsSync(SESSOES_DIR)) fs.mkdirSync(SESSOES_DIR, { recursive: true });
}

function novoId() {
  return 'rp_' + crypto.randomBytes(6).toString('hex');
}

function caminho(id) {
  return path.join(SESSOES_DIR, `${id}.json`);
}

function criar({ consultor, personaId, modalidade, briefing }) {
  ensureDir();
  const id = novoId();
  const sessao = {
    id,
    consultor: consultor || 'desconhecido',
    personaId,
    modalidade: modalidade || 'r1',
    // Intenção/briefing do cliente: o que o lead veio buscar. Entra como CONTEXTO
    // no avaliador pra o cross-sell ser medido contra a oportunidade real, não
    // contra um ideal abstrato. Opcional — sessão antiga sem briefing continua válida.
    briefing: (briefing && String(briefing).trim()) || '',
    status: 'em_andamento', // em_andamento | encerrada | avaliada
    criadoEm: new Date().toISOString(),
    encerradoEm: null,
    turnos: [], // { autor: 'lead'|'consultor', texto, ts }
    avaliacao: null,
    crmRecordId: null,
  };
  salvar(sessao);
  return sessao;
}

function carregar(id) {
  const p = caminho(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function salvar(sessao) {
  ensureDir();
  fs.writeFileSync(caminho(sessao.id), JSON.stringify(sessao, null, 2));
  return sessao;
}

function addTurno(id, autor, texto) {
  const s = carregar(id);
  if (!s) return null;
  s.turnos.push({ autor, texto, ts: new Date().toISOString() });
  return salvar(s);
}

function listar() {
  ensureDir();
  return fs
    .readdirSync(SESSOES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSOES_DIR, f), 'utf8'));
        return {
          id: s.id,
          consultor: s.consultor,
          personaId: s.personaId,
          modalidade: s.modalidade,
          status: s.status,
          criadoEm: s.criadoEm,
          turnos: s.turnos.length,
          scoreGeral: s.avaliacao ? s.avaliacao.scoreGeral : null,
        };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
}

// Transcript legível pra prompt do lead / avaliador.
function transcriptTexto(sessao) {
  return sessao.turnos
    .map((t) => `${t.autor === 'lead' ? 'LEAD' : 'CONSULTOR'}: ${t.texto}`)
    .join('\n');
}

module.exports = { criar, carregar, salvar, addTurno, listar, transcriptTexto, SESSOES_DIR };
