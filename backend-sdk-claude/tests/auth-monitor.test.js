// services/health/auth-monitor.js — unit tests
// Estado authDown (plano Claude desconectado): detecção de 401, threshold,
// persistência e eventos. STATE_FILE/CREDENTIALS_FILE apontam pra tmpdir
// (tests/setup.js) — nada toca o data/ real nem ~/.claude/.

const fs = require('fs');

const STATE_FILE = process.env.AUTH_STATE_FILE;
const CLI_401 = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_test"}';

function freshMonitor() {
  const { AuthMonitor } = require('../services/health/auth-monitor');
  return new AuthMonitor();
}

describe('auth-monitor', () => {
  let monitor;

  beforeEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch (_) {}
    monitor = freshMonitor();
  });

  afterEach(() => {
    monitor._stopProbe();
    jest.restoreAllMocks();
  });

  describe('isAuthError', () => {
    const { isAuthError } = require('../services/health/auth-monitor');

    test.each([
      CLI_401,
      'Failed to authenticate',
      'API Error: 401',
      'api error 401 whatever',
      'blah authentication_error blah',
      'Invalid authentication credentials',
      'OAuth token has expired',
      'oauth token revoked',
    ])('detecta: %s', (msg) => {
      expect(isAuthError(msg)).toBe(true);
    });

    test.each([
      'O erro 401 significa não autorizado',
      'missão 401 concluída',
      'a porta 4011 está aberta',
      'rate limit reached',
      '',
      null,
      undefined,
    ])('NÃO detecta: %s', (msg) => {
      expect(isAuthError(msg)).toBe(false);
    });
  });

  describe('isAuthErrorStrict', () => {
    const { isAuthErrorStrict } = require('../services/health/auth-monitor');

    test('detecta o erro cru do CLI', () => {
      expect(isAuthErrorStrict(CLI_401)).toBe(true);
    });

    test('detecta prefixo "Failed to authenticate"', () => {
      expect(isAuthErrorStrict('Failed to authenticate.')).toBe(true);
    });

    test('NÃO detecta resposta legítima explicando erro 401', () => {
      // Resposta do bot a "o que é erro 401?" — menciona os termos mas não é o erro.
      const legit = 'O erro 401 (authentication_error) acontece quando as credenciais são inválidas. '
        + 'Pra resolver, verifique seu token de acesso e faça login de novo. '.repeat(20);
      expect(isAuthErrorStrict(legit)).toBe(false); // > 800 chars
    });

    test('NÃO detecta "401" solto nem menção parcial curta', () => {
      expect(isAuthErrorStrict('O status 401 indica falta de autenticação')).toBe(false);
      expect(isAuthErrorStrict('authentication_error é um tipo de erro')).toBe(false);
    });
  });

  describe('threshold 2-em-120s', () => {
    test('uma falha isolada NÃO liga o down', () => {
      monitor.reportAuthFailure(CLI_401);
      expect(monitor.isDown()).toBe(false);
      expect(monitor.status().failCount).toBe(1);
    });

    test('segunda falha dentro da janela liga o down e emite "down"', () => {
      const downEvents = [];
      monitor.on('down', (s) => downEvents.push(s));
      monitor.reportAuthFailure(CLI_401);
      monitor.reportAuthFailure(CLI_401);
      expect(monitor.isDown()).toBe(true);
      expect(downEvents).toHaveLength(1);
      monitor._stopProbe();
    });

    test('falhas separadas por mais de 120s NÃO acumulam', () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      monitor.reportAuthFailure(CLI_401);
      now += 121_000; // janela expirou — contador reseta
      monitor.reportAuthFailure(CLI_401);
      expect(monitor.isDown()).toBe(false);
      expect(monitor.status().failCount).toBe(1);
    });
  });

  describe('persistência', () => {
    test('estado down sobrevive a restart (novo require/instância)', () => {
      monitor._forceDown(CLI_401);
      monitor.markNotified('120363@g.us');
      monitor._stopProbe();

      const revived = freshMonitor();
      expect(revived.isDown()).toBe(true);
      expect(revived.getNotifiedJids()).toEqual(['120363@g.us']);
      revived._stopProbe();
    });

    test('lastSample é truncado a 500 chars', () => {
      monitor.reportAuthFailure('x'.repeat(2000));
      expect(monitor.status().lastSample).toHaveLength(500);
    });
  });

  describe('recuperação', () => {
    test('_forceUp limpa o estado e emite "up" com os jids avisados', () => {
      monitor._forceDown(CLI_401);
      monitor.markNotified('a@g.us');
      monitor.markNotified('b@s.whatsapp.net');

      const upEvents = [];
      monitor.on('up', (e) => upEvents.push(e));
      monitor._forceUp();

      expect(monitor.isDown()).toBe(false);
      expect(monitor.status().failCount).toBe(0);
      expect(upEvents).toHaveLength(1);
      expect(upEvents[0].notifiedJids.sort()).toEqual(['a@g.us', 'b@s.whatsapp.net']);
    });

    test('clearNotified zera a lista', () => {
      monitor._forceDown(CLI_401);
      monitor.markNotified('a@g.us');
      monitor.clearNotified();
      expect(monitor.getNotifiedJids()).toEqual([]);
      monitor._stopProbe();
    });
  });

  describe('probe', () => {
    test('_tokenLooksExpired lê expiresAt do credentials.json', () => {
      const credsFile = process.env.CLAUDE_CREDENTIALS_FILE;
      fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() - 1000 } }));
      expect(monitor._tokenLooksExpired()).toBe(true);
      fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }));
      expect(monitor._tokenLooksExpired()).toBe(false);
      fs.unlinkSync(credsFile);
      expect(monitor._tokenLooksExpired()).toBe(false); // sem arquivo: deixa o probe decidir
    });
  });
});
