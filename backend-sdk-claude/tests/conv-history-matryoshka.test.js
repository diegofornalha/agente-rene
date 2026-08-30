// Regressão do bug matryoshka (fix 2026-07-02): o histórico de conversa
// gravava o PROMPT MONTADO (wrapper de injeção + histórico + "Mensagem atual:")
// em vez da mensagem crua do interlocutor — cada turno re-aninhava o wrapper
// do turno anterior, inflando o contexto até exigir /reset.
//
// Cobre:
//  1. _extractCurrentMessage (fallback pra zombie tasks sem ctx.rawMessage)
//  2. Simulação de 3 turnos do loop real (getFormattedHistory → finalPrompt →
//     addTurn): o prompt do turno N deve conter EXATAMENTE 1 header de
//     contexto, nunca aninhamento.

// Baileys é ESM puro — jest (CJS) não compila o import. O teste só precisa
// de _extractCurrentMessage, então mockamos o pacote inteiro.
jest.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  fetchLatestBaileysVersion: jest.fn(),
  DisconnectReason: {},
  downloadMediaMessage: jest.fn(),
  jidNormalizedUser: jest.fn((j) => j),
}), { virtual: false });

const convHistory = require('../services/memory/conversation-history');
const { _extractCurrentMessage } = require('../services/whatsapp/whatsapp-channel');

const HEADER = '### Contexto da conversa anterior';

function countOccurrences(str, needle) {
  return str.split(needle).length - 1;
}

// Réplica da montagem de prompt em whatsapp-channel.js (linha ~1415).
function buildFinalPrompt(jid, rawMsg) {
  const historyCtx = convHistory.getFormattedHistory('wa', jid, 4);
  const quemFala = '[Você está conversando com Diego. Trate-o pelo nome certo.]\n';
  return `${quemFala}${historyCtx ? '\n' + historyCtx : ''}\nMensagem atual: ${rawMsg}`;
}

describe('_extractCurrentMessage', () => {
  test('prompt sem wrapper retorna o próprio texto (já é cru)', () => {
    expect(_extractCurrentMessage('oi, tudo bem?')).toBe('oi, tudo bem?');
  });

  test('extrai mensagem após "Mensagem atual:"', () => {
    const p = '[Você está conversando com Diego.]\n\n### Contexto da conversa anterior:\n[Usuário]: oi\n\nMensagem atual: pode implementar a correção';
    expect(_extractCurrentMessage(p)).toBe('pode implementar a correção');
  });

  test('prompt matryoshka (múltiplos marcadores) usa o ÚLTIMO', () => {
    const p = 'wrapper\nMensagem atual: [wrapper aninhado]\nMensagem atual: oi\nfim de citação\nMensagem atual: mensagem real';
    expect(_extractCurrentMessage(p)).toBe('mensagem real');
  });

  test('null/vazio retorna null', () => {
    expect(_extractCurrentMessage(null)).toBeNull();
    expect(_extractCurrentMessage('')).toBeNull();
    expect(_extractCurrentMessage(undefined)).toBeNull();
  });
});

describe('histórico não aninha wrapper (anti-matryoshka)', () => {
  const jid = `test-matryoshka-${Date.now()}@s.whatsapp.net`;

  afterAll(() => convHistory.clearSession('wa', jid));

  test('3 turnos gravando a mensagem CRUA → prompt tem exatamente 1 header', () => {
    const msgs = ['oi', 'sabe o que é o René?', 'pode implementar a correção'];
    let lastPrompt = '';
    for (const msg of msgs) {
      lastPrompt = buildFinalPrompt(jid, msg);
      // FIX: grava a mensagem crua (ctx.rawMessage), nunca lastPrompt.
      convHistory.addTurn('wa', jid, msg, `resposta pra "${msg}"`);
    }
    expect(countOccurrences(lastPrompt, HEADER)).toBe(1);
    // Nenhum turno armazenado contém wrapper ou header.
    for (const entry of convHistory.getHistory('wa', jid)) {
      if (entry.role !== 'user') continue;
      expect(entry.content).not.toContain(HEADER);
      expect(entry.content).not.toContain('[Você está conversando com');
      expect(entry.content).not.toContain('Mensagem atual:');
    }
  });

  test('comportamento ANTIGO (gravar prompt montado) reproduz o aninhamento — sanity do teste', () => {
    const jidBug = `test-matryoshka-bug-${Date.now()}@s.whatsapp.net`;
    let lastPrompt = '';
    for (const msg of ['oi', 'tudo bem?', 'e aí?']) {
      lastPrompt = buildFinalPrompt(jidBug, msg);
      convHistory.addTurn('wa', jidBug, lastPrompt, 'resposta'); // BUG proposital
    }
    expect(countOccurrences(lastPrompt, HEADER)).toBeGreaterThan(1);
    convHistory.clearSession('wa', jidBug);
  });
});
