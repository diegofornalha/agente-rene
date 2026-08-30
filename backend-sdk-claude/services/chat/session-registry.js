'use strict';
// session-registry.js — estado in-memory do chat Socket.IO: sessões, conexões
// ativas e dedup de mensagens, com os cleaners periódicos. (Em produção de
// verdade isso seria Redis/DB; o session-store SQLite cobre a persistência.)

const logger = require('../logger');

// In-memory session storage (in production, use Redis or database)
const sessions = new Map();
const activeConnections = new Map();
// Sistema de deduplicação de mensagens
const processedMessages = new Map();

const MESSAGE_TTL = 30000; // 30 seconds

// Registra os cleaners periódicos. Chamar UMA vez no boot, com o io — o
// cleaner de conexões consulta io.sockets pra detectar sockets mortos.
let _cleanupsStarted = false;
function startCleanups(io) {
  if (_cleanupsStarted) return;
  _cleanupsStarted = true;

  // Limpeza automática de mensagens antigas
  setInterval(() => {
    const now = Date.now();
    for (const [messageId, timestamp] of processedMessages.entries()) {
      if (now - timestamp > MESSAGE_TTL) {
        processedMessages.delete(messageId);
      }
    }
  }, 60000); // Limpar a cada minuto

  // Limpeza de conexões stale que nunca dispararam 'disconnect'
  const CONNECTION_STALE_MS = 5 * 60 * 1000; // 5 minutos sem atividade
  setInterval(() => {
    const now = Date.now();
    for (const [socketId, info] of activeConnections.entries()) {
      const socket = io.sockets?.sockets?.get(socketId);
      if (!socket || socket.disconnected) {
        activeConnections.delete(socketId);
      } else if (now - info.connectedAt > CONNECTION_STALE_MS && !info.lastActivity) {
        // Conexão antiga sem atividade registrada — manter mas marcar
        info.lastActivity = info.lastActivity || info.connectedAt;
      }
    }
  }, 60000);

  // Limpeza de sessões sem atividade (4 horas)
  setInterval(() => {
    const now = Date.now();
    const SESSION_TTL = 4 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const [sessionId, data] of sessions.entries()) {
      if (data.lastActivity && (now - data.lastActivity > SESSION_TTL)) {
        sessions.delete(sessionId);
        cleaned++;
      }
    }
    if (cleaned > 0) logger.info(`🧹 Cleaned ${cleaned} stale sessions`);
  }, 3600000); // A cada hora
}

function _sanitizeTask(task) {
  const { _abortController, _timeoutId, ...safe } = task;
  return safe;
}

module.exports = {
  sessions,
  activeConnections,
  processedMessages,
  MESSAGE_TTL,
  startCleanups,
  _sanitizeTask,
};
