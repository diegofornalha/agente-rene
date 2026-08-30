// Connection Status — expõe estado da conexão WhatsApp e permite force-reconnect.
//
// Uso:
//   const connStatus = require('./services/health/connection-status');
//   connStatus.register(whatsappChannel); // após iniciar o canal
//   connStatus.status();   // → { connected: true, upSince: ..., reconnects: 2, ... }
//   connStatus.forceReconnect(); // desconecta e reconecta

class ConnectionStatus {
  constructor() {
    this._channel = null;
    this._state = 'unknown';     // unknown | connecting | open | close
    this._upSince = null;
    this._lastDisconnect = null;
    this._reconnectCount = 0;
    this._lastError = null;
    this._history = [];          // últimos 20 eventos
  }

  register(channel) {
    this._channel = channel;
  }

  // Chamado pelo whatsapp-channel.js nos eventos connection.update
  onConnectionUpdate(update) {
    const { connection, lastDisconnect } = update;
    if (!connection) return;

    const prev = this._state;
    this._state = connection;

    const event = {
      from: prev,
      to: connection,
      ts: new Date().toISOString(),
    };

    if (connection === 'open') {
      this._upSince = new Date().toISOString();
      this._lastError = null;
      if (prev === 'close' || prev === 'connecting') {
        this._reconnectCount++;
      }
    }

    if (connection === 'close') {
      this._lastDisconnect = new Date().toISOString();
      if (lastDisconnect?.error) {
        this._lastError = {
          message: lastDisconnect.error.message || String(lastDisconnect.error),
          code: lastDisconnect.error?.output?.statusCode,
          ts: new Date().toISOString(),
        };
        event.error = this._lastError.message;
      }
    }

    this._history.push(event);
    if (this._history.length > 20) this._history.shift();
  }

  status() {
    const now = Date.now();
    const uptimeMs = this._upSince ? now - new Date(this._upSince).getTime() : 0;

    return {
      state: this._state,
      connected: this._state === 'open',
      upSince: this._upSince,
      uptimeSeconds: Math.round(uptimeMs / 1000),
      reconnectCount: this._reconnectCount,
      lastDisconnect: this._lastDisconnect,
      lastError: this._lastError,
      history: this._history.slice(-10),
      checkedAt: new Date().toISOString(),
    };
  }

  async forceReconnect() {
    if (!this._channel) {
      return { success: false, error: 'No WhatsApp channel registered' };
    }

    try {
      // Tenta fechar a conexão existente
      if (this._channel.sock) {
        this._channel.sock.end(undefined);
      }

      // O reconnect automático do Baileys vai reconectar via connection.update handler
      return {
        success: true,
        message: 'Disconnect signal sent — Baileys auto-reconnect will kick in',
        previousState: this._state,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// Singleton
const instance = new ConnectionStatus();

module.exports = instance;
module.exports.ConnectionStatus = ConnectionStatus;
