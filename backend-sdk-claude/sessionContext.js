// Sistema de contexto de sessão.
//
// Reads vêm sempre da Map em memória (source of truth). Writes vão para a Map
// imediatamente e são espelhados de forma assíncrona pro session-store SQLite
// — um no-op quando SESSION_STORE_BACKEND=memory (default), persistente quando
// SESSION_STORE_BACKEND=sqlite. Restart do PM2 rehidrata as sessões ativas das
// últimas 2h direto da base.

const sessionStore = require('./services/memory/session-store');

const SCOPE = 'context';
const TTL_MS = 2 * 60 * 60 * 1000;      // 2h sem atividade
const MAX_MSGS = 20;                     // últimas 20 mensagens por sessão

class SessionContextManager {
  constructor() {
    this.sessionContexts = new Map();

    const rehydrated = sessionStore.rehydrate({ scope: SCOPE, maxAgeMs: TTL_MS });
    for (const [sid, data] of rehydrated.entries()) {
      this.sessionContexts.set(sid, data);
    }
    if (rehydrated.size > 0) {
      console.log(`📦 [CONTEXT] Rehydrated ${rehydrated.size} sessions from SQLite (backend=${sessionStore.BACKEND})`);
    } else if (sessionStore.BACKEND === 'sqlite') {
      console.log(`📦 [CONTEXT] SQLite backend ativo, nenhuma sessão recente para rehidratar`);
    }

    // Limpar contextos antigos a cada hora
    setInterval(() => this.cleanOldContexts(), 3600000);
  }

  // Adicionar mensagem ao contexto da sessão
  addToContext(sessionId, role, content) {
    if (!this.sessionContexts.has(sessionId)) {
      this.sessionContexts.set(sessionId, {
        messages: [],
        createdAt: Date.now(),
        lastActivity: Date.now()
      });
    }

    const context = this.sessionContexts.get(sessionId);
    const timestamp = Date.now();

    context.messages.push({ role, content, timestamp });

    // Limitar a MAX_MSGS mais recentes para economizar memória
    if (context.messages.length > MAX_MSGS) {
      context.messages = context.messages.slice(-MAX_MSGS);
    }

    context.lastActivity = timestamp;

    // Mirror para SQLite (no-op se backend=memory).
    sessionStore.persistMessage({
      scope: SCOPE,
      sessionId,
      role,
      content,
      timestamp,
      createdAt: context.createdAt,
      maxKeep: MAX_MSGS,
    });

    if (process.env.DEBUG) console.log(`📝 [CONTEXT] Added ${role} message to session ${sessionId.slice(0, 8)}. Total: ${context.messages.length}`);
  }

  // Obter contexto formatado para enviar ao Claude
  getFormattedContext(sessionId, currentMessage) {
    const context = this.sessionContexts.get(sessionId);

    if (!context || context.messages.length === 0) {
      return currentMessage;
    }

    let contextPrompt = "Contexto da conversa anterior:\n";

    const recentMessages = context.messages.slice(-MAX_MSGS);

    recentMessages.forEach(msg => {
      if (msg.role === 'user') {
        contextPrompt += `\nUsuário: ${msg.content}`;
      } else {
        contextPrompt += `\nAssistente: ${msg.content}`;
      }
    });

    contextPrompt += `\n\n---\nNova mensagem do usuário: ${currentMessage}`;
    contextPrompt += `\n\nIMPORTANTE: Use o contexto acima para responder de forma coerente e lembrando das informações anteriores da conversa.`;

    return contextPrompt;
  }

  // Obter resumo do contexto
  getContextSummary(sessionId) {
    const context = this.sessionContexts.get(sessionId);

    if (!context) {
      return null;
    }

    const summary = {
      messageCount: context.messages.length,
      sessionAge: Date.now() - context.createdAt,
      lastActivity: Date.now() - context.lastActivity
    };

    const userNameMatch = context.messages.find(msg =>
      msg.content.match(/meu nome é (\w+)/i) ||
      msg.content.match(/me chamo (\w+)/i) ||
      msg.content.match(/sou o (\w+)/i) ||
      msg.content.match(/sou a (\w+)/i)
    );

    if (userNameMatch) {
      const match = userNameMatch.content.match(/(?:meu nome é|me chamo|sou o|sou a) (\w+)/i);
      if (match) {
        summary.userName = match[1];
      }
    }

    return summary;
  }

  // Limpar contexto de uma sessão
  clearContext(sessionId) {
    this.sessionContexts.delete(sessionId);
    sessionStore.purge({ scope: SCOPE, sessionId });
    console.log(`🧹 [CONTEXT] Cleared context for session ${sessionId.slice(0, 8)}`);
  }

  // Limpar contextos antigos (mais de 2 horas sem atividade)
  cleanOldContexts() {
    const cutoff = Date.now() - TTL_MS;
    let cleaned = 0;

    for (const [sessionId, context] of this.sessionContexts.entries()) {
      if (context.lastActivity < cutoff) {
        this.sessionContexts.delete(sessionId);
        sessionStore.purge({ scope: SCOPE, sessionId });
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 [CONTEXT] Cleaned ${cleaned} old session contexts`);
    }
  }

  // Obter estatísticas
  getStats() {
    const stats = {
      totalSessions: this.sessionContexts.size,
      totalMessages: 0,
      averageMessagesPerSession: 0,
      storeBackend: sessionStore.BACKEND,
    };

    for (const context of this.sessionContexts.values()) {
      stats.totalMessages += context.messages.length;
    }

    if (stats.totalSessions > 0) {
      stats.averageMessagesPerSession = Math.round(stats.totalMessages / stats.totalSessions);
    }

    return stats;
  }
}

module.exports = SessionContextManager;
