// Auth Monitor — estado global "plano Claude desconectado" (authDown).
//
// Quando o dono desloga/troca de conta no Claude Code da máquina, a API passa
// a retornar 401 e o CLI devolve "Failed to authenticate. API Error: 401 ..."
// como se fosse resposta. Este módulo centraliza:
//   - detecção do padrão (isAuthError/isAuthErrorStrict)
//   - o estado down/up com threshold anti-falso-positivo (2 falhas em 120s)
//   - persistência entre restarts (data/auth-state.json)
//   - probe de auto-recuperação (mtime do credentials.json + query de teste)
//
// Consumidores (task-runner, whatsapp-channel, health-checker) só importam
// daqui — este módulo não importa nenhum deles (sem dependência circular).
//
// Uso:
//   const authMonitor = require('./services/health/auth-monitor');
//   authMonitor.reportAuthFailure(errMsg);   // quem viu o 401 reporta
//   if (authMonitor.isDown()) ...            // guards síncronos
//   authMonitor.on('down', () => ...);       // avisar chats
//   authMonitor.on('up',   () => ...);       // anunciar recuperação + drenar fila

const { EventEmitter } = require('events');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Ambos overridáveis por env — testes apontam pra tmpdir (jest é puro/mockado).
const STATE_FILE = process.env.AUTH_STATE_FILE
  || path.join(__dirname, '..', '..', 'data', 'auth-state.json');
const CREDENTIALS_FILE = process.env.CLAUDE_CREDENTIALS_FILE
  || path.join(os.homedir(), '.claude', '.credentials.json');

// Threshold: 2 falhas dentro da janela ligam o estado down. Uma falha isolada
// pode ser um 401 transitório durante refresh do token OAuth — a ressuscitação
// 1x do WhatsApp dá a segunda chance natural; se falhar de novo, liga.
const FAIL_THRESHOLD = 2;
const FAIL_WINDOW_MS = 120_000;

// Probe de recuperação: mtime é barato (relogin reescreve o credentials.json),
// a query de validação é o teste real (só ela passa pela API autenticada).
const MTIME_POLL_MS = 20_000;
const PROBE_FALLBACK_MS = 10 * 60_000; // token pode renovar sem tocar o arquivo
const PROBE_MODEL = process.env.AUTH_PROBE_MODEL || 'claude-haiku-4-5';

// ── Detecção ──
// Nunca dar match em "401" solto: usuário perguntando "o que é erro 401?"
// recebe resposta legítima contendo o número.
function isAuthError(text) {
  const t = String(text || '');
  return /failed to authenticate/i.test(t)
    || /authentication_error/i.test(t)
    || /invalid (authentication|bearer) (credentials|token)/i.test(t)
    || /oauth token (has )?(expired|revoked)/i.test(t)
    || /api error:?\s*401\b/i.test(t);
}

// Variante estrita pra superfícies que PODEM conter conteúdo legítimo
// (task.result, step.text): exige o formato exato do erro do CLI, curto.
// Uma resposta explicando "erro 401" pro usuário é longa e não começa com
// "Failed to authenticate".
function isAuthErrorStrict(text) {
  const t = String(text || '').trim();
  if (t.length > 800) return false;
  return /^failed to authenticate/i.test(t)
    || (/api error:?\s*401\b/i.test(t) && /authentication_error/i.test(t));
}

class AuthMonitor extends EventEmitter {
  constructor() {
    super();
    this._down = false;
    this._downSince = null;
    this._failCount = 0;
    this._firstFailAt = null;
    this._lastSample = null;
    this._notifiedJids = new Set();
    this._probing = false;
    this._mtimeTimer = null;
    this._probeTimer = null;
    this._load();
    if (this._down) this._startProbe();
  }

  // ── Persistência (atômica tmp+rename, padrão do task-runner) ──

  _load() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const s = fs.readJsonSync(STATE_FILE);
      this._down = !!s.down;
      this._downSince = s.downSince || null;
      this._failCount = s.failCount || 0;
      this._lastSample = s.lastSample || null;
      this._notifiedJids = new Set(Array.isArray(s.notifiedJids) ? s.notifiedJids : []);
      if (this._down) {
        console.warn(`🔐 auth-monitor: estado authDown rehidratado (down desde ${new Date(this._downSince).toISOString()})`);
      }
    } catch (e) {
      console.warn('⚠️ auth-monitor: failed to load state:', e.message);
    }
  }

  _save() {
    try {
      fs.ensureDirSync(path.dirname(STATE_FILE));
      const tmp = STATE_FILE + '.tmp';
      fs.writeJsonSync(tmp, {
        down: this._down,
        downSince: this._downSince,
        failCount: this._failCount,
        notifiedJids: [...this._notifiedJids],
        lastSample: this._lastSample,
      }, { spaces: 2 });
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.error('❌ auth-monitor: failed to save state:', e.message);
    }
  }

  // ── API de estado ──

  isDown() {
    return this._down;
  }

  status() {
    return {
      down: this._down,
      downSince: this._downSince,
      failCount: this._failCount,
      lastSample: this._lastSample,
      probing: this._probing,
      notifiedJids: [...this._notifiedJids],
      checkedAt: new Date().toISOString(),
    };
  }

  // Quem viu um erro de auth (task-runner, _formatReply defensivo) reporta aqui.
  reportAuthFailure(sample) {
    const now = Date.now();
    this._lastSample = String(sample || '').slice(0, 500); // diagnóstico, nunca vai a chat
    if (this._down) { this._save(); return; }

    if (!this._firstFailAt || (now - this._firstFailAt) > FAIL_WINDOW_MS) {
      this._firstFailAt = now;
      this._failCount = 1;
    } else {
      this._failCount++;
    }
    console.warn(`🔐 auth-monitor: falha de auth reportada (${this._failCount}/${FAIL_THRESHOLD} na janela)`);

    if (this._failCount >= FAIL_THRESHOLD) {
      this._down = true;
      this._downSince = now;
      this._save();
      console.error('🔐 auth-monitor: plano Claude DESCONECTADO (authDown ligado) — segurando fila e curto-circuitando mensagens');
      this._startProbe();
      this.emit('down', this.status());
    } else {
      this._save();
    }
  }

  // Chats que já receberam o aviso de queda (pra anunciar a recuperação neles).
  markNotified(jid) {
    if (!jid || this._notifiedJids.has(jid)) return;
    this._notifiedJids.add(jid);
    this._save();
  }

  getNotifiedJids() {
    return [...this._notifiedJids];
  }

  clearNotified() {
    this._notifiedJids.clear();
    this._save();
  }

  // ── Probe de recuperação ──

  _startProbe() {
    if (this._mtimeTimer) return; // já rodando
    let lastMtime = this._credentialsMtime();

    this._mtimeTimer = setInterval(() => {
      const m = this._credentialsMtime();
      if (m && m !== lastMtime) {
        lastMtime = m;
        console.log('🔐 auth-monitor: credentials.json mudou — validando auth agora');
        this._probe();
      }
    }, MTIME_POLL_MS);

    this._probeTimer = setInterval(() => this._probe(), PROBE_FALLBACK_MS);
    // .unref(): probe não deve segurar o processo vivo sozinho (jest, shutdown)
    if (this._mtimeTimer.unref) this._mtimeTimer.unref();
    if (this._probeTimer.unref) this._probeTimer.unref();
  }

  _stopProbe() {
    if (this._mtimeTimer) { clearInterval(this._mtimeTimer); this._mtimeTimer = null; }
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
  }

  _credentialsMtime() {
    try { return fs.statSync(CREDENTIALS_FILE).mtimeMs; } catch (_) { return null; }
  }

  // Token certamente vencido → nem gasta um spawn no probe.
  _tokenLooksExpired() {
    try {
      const creds = fs.readJsonSync(CREDENTIALS_FILE);
      const exp = creds?.claudeAiOauth?.expiresAt;
      return typeof exp === 'number' && exp < Date.now();
    } catch (_) { return false; } // sem arquivo/parse: deixa o probe decidir
  }

  // Validação real: só uma query autenticada prova que o login voltou
  // (cli --version não passa pela API). 1 turno curto no Haiku — desprezível.
  async _probe() {
    if (!this._down || this._probing) return;
    if (this._tokenLooksExpired()) {
      console.log('🔐 auth-monitor: probe pulado (expiresAt do token já venceu)');
      return;
    }
    this._probing = true;
    try {
      // Lazy require: evita custo no boot e qualquer risco de ciclo.
      const { query } = require('../../claude-query');
      let resultText = null;
      let sawError = false;
      for await (const msg of query({
        prompt: 'Responda apenas: ok',
        options: { maxTurns: 1, model: PROBE_MODEL, permissionMode: 'bypassPermissions' },
      })) {
        if (msg.type === 'result') {
          resultText = typeof msg.result === 'string' ? msg.result : '';
          if (msg.is_error || isAuthError(resultText)) sawError = true;
        }
      }
      if (!sawError && resultText !== null) {
        this._setUp();
      } else {
        console.log(`🔐 auth-monitor: probe falhou — segue down (${String(resultText).slice(0, 120)})`);
      }
    } catch (e) {
      console.log(`🔐 auth-monitor: probe erro — segue down (${e.message})`);
    } finally {
      this._probing = false;
    }
  }

  _setUp() {
    this._stopProbe();
    const notified = [...this._notifiedJids];
    this._down = false;
    this._downSince = null;
    this._failCount = 0;
    this._firstFailAt = null;
    this._save();
    console.log('🔐 auth-monitor: plano Claude RECONECTADO (authDown desligado) — retomando operação');
    this.emit('up', { notifiedJids: notified });
  }

  // Ops/teste (endpoint /api/auth-status): força estado sem esperar falhas.
  _forceDown(sample) {
    this._failCount = FAIL_THRESHOLD;
    this._down = true;
    this._downSince = Date.now();
    this._lastSample = String(sample || 'forced').slice(0, 500);
    this._save();
    this._startProbe();
    this.emit('down', this.status());
  }

  _forceUp() {
    this._setUp();
  }
}

const instance = new AuthMonitor();

module.exports = instance;
module.exports.isAuthError = isAuthError;
module.exports.isAuthErrorStrict = isAuthErrorStrict;
module.exports.AuthMonitor = AuthMonitor;
