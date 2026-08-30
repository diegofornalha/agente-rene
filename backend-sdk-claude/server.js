require('dotenv').config();
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

// Workspace dos scripts René/Instagram (download/tradução/publicação).
// Portável: sobrescreva com RENE_WORKSPACE no .env. Os scripts Python em si
// (instagram/, linkedin_poster.py, translate-image.py) precisam existir aqui —
// não fazem parte deste repositório.
const RENE_WS = process.env.RENE_WORKSPACE || path.join(os.homedir(), '.hermes', 'workspace');
const { query, isThrottled } = require('./claude-query');
const SessionContextManager = require('./sessionContext');
const HealthChecker = require('./services/health/health-checker');
const taskRunner = require('./services/tasks/task-runner');
const cronScheduler = require('./services/tasks/cron-scheduler');
const kanban = require('./services/tasks/kanban');
const sessionsSearch = require('./services/memory/sessions-search');
const mcpClient = require('./services/mcp/mcp-client');
const pluginLoader = require('./services/skills/plugin-loader');
const hooksService = require('./services/health/hooks');
const llmsIndex = require('./services/skills/llms-index');
const metrics = require('./services/health/metrics');
const skillsHub = require('./services/skills/skills-hub-local');
const heygen = require('./services/media/heygen');
const heygenReels = require('./services/media/heygen-reels');
const rotaFiscalLeads = require('./services/leads/rota-fiscal-leads');
const roadmapCron = require('./services/roadmap-cron');
const automationCron = require('./services/automations/automation-cron');
const convHistory = require('./services/memory/conversation-history');


// Logger pluggável (services/logger.js). LOG_BACKEND=console (default) mantém
// o comportamento atual; LOG_BACKEND=pino ativa NDJSON + rotação diária em ./logs/.
const logger = require('./services/logger');

const { app, server, io, upload } = require('./app');

const {
  sessions, activeConnections, processedMessages,
  startCleanups, _sanitizeTask,
} = require('./services/chat/session-registry');
startCleanups(io);

// Referência ao canal WhatsApp pra rotas externas (POST /api/whatsapp/say)
let whatsappChannel = null;

const {
  isClaudeLimitError, extractResetTime, getClaudeResetTime,
  getStepMessage, getStepData, extractTextContent,
} = require('./services/chat/step-formatter');

// Initialize clients
const sessionContextManager = new SessionContextManager();

// Initialize Health Checker
const healthChecker = new HealthChecker();
const watchdog = require('./services/health/watchdog');
const diskUsage = require('./services/health/disk-usage');
const connStatus = require('./services/health/connection-status');
const healthCron = require('./services/health/health-cron');

// Initialize all systems
async function initializeSystem() {
  console.log('🚀 Initializing Chat Server Systems...');

  try {
    console.log('📋 System Status:');
    console.log('  Session Context: ✅ Active');

  } catch (error) {
    console.error('❌ System initialization error:', error);
  }
}

// Initialize on startup
initializeSystem();

// Autonomous mode
const AUTONOMOUS_INTERVAL = parseInt(process.env.AUTONOMOUS_INTERVAL_MIN || '0') * 60 * 1000;
if (AUTONOMOUS_INTERVAL > 0) {
  taskRunner.startAutonomous(io, AUTONOMOUS_INTERVAL);
}



// ── llms.txt público (sem auth) — índice canônico do mythos ──
// Rotas modularizadas — ver routes/*.js
require('./routes/system')(app, { upload, sessionContextManager });
require('./routes/health')(app, { io, healthChecker });

require('./routes/whatsapp')(app, { getWhatsappChannel: () => whatsappChannel, sessionContextManager });
require('./routes/heygen')(app, { getWhatsappChannel: () => whatsappChannel });

require('./routes/tasks')(app);
require('./routes/misc')(app, { io, RENE_WS });
require('./routes/roleplay')(app);
require('./routes/google')(app);

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info('Client connected:', socket.id);
  activeConnections.set(socket.id, { connectedAt: Date.now() });
  let currentAbortController = null;

  // Send connection stats
  socket.emit('connection_stats', {
    active_connections: activeConnections.size,
    active_sessions: sessions.size
  });

  // Cancelar mensagem em andamento
  socket.on('cancel_message', () => {
    if (currentAbortController && !currentAbortController.signal.aborted) {
      currentAbortController.abort();
      socket.emit('typing_end');
      socket.emit('processing_step', {
        step: 'cancelled',
        message: 'Mensagem cancelada.',
        timestamp: Date.now()
      });
    }
  });

  // CONSOLIDATED MESSAGE HANDLER - Único ponto de processamento
  socket.on('send_message', async (data) => {
    // Gerar ID único para esta mensagem
    const messageId = `${socket.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Verificar se mensagem já foi processada
    if (processedMessages.has(messageId) || 
        (data.messageId && processedMessages.has(data.messageId))) {
      logger.debug('🔄 DEDUP: ignoring:', messageId);
      return;
    }
    
    // Marcar mensagem como sendo processada
    const finalMessageId = data.messageId || messageId;
    processedMessages.set(finalMessageId, Date.now());
    
    logger.debug('📥 Processing message:', finalMessageId);
    
    try {
      const {
        message,
        sessionId,
        systemPrompt,
        maxTurns = 5,
        allowedTools = [],
        customOptions = {}
      } = data;
      
      if (!message || !message.trim()) {
        logger.debug('❌ Empty message rejected');
        socket.emit('error', { 
          error: 'Message cannot be empty',
          messageId: finalMessageId
        });
        // Remover da lista de processadas já que falhou
        processedMessages.delete(finalMessageId);
        return;
      }
      
      logger.debug('✅ Message validated:', {
        messagePreview: message.substring(0, 100),
        sessionId: sessionId,
        hasSystemPrompt: !!systemPrompt
      });

      // Generate session ID if not provided
      const currentSessionId = sessionId || uuidv4();
      
      // Get or create session
      let sessionData = sessions.get(currentSessionId) || {
        id: currentSessionId,
        created: Date.now(),
        messages: [],
        title: message.length > 50 ? message.substring(0, 50) + '...' : message
      };

      // Add user message to session
      const userMessage = {
        id: uuidv4(),
        type: 'user',
        role: 'user', // IMPORTANTE: Adicionar role para consistência
        content: message,
        timestamp: Date.now()
      };
      
      sessionData.messages.push(userMessage);
      sessionData.lastActivity = Date.now();
      sessions.set(currentSessionId, sessionData);
      
      // Emit user message
      socket.emit('message', {
        ...userMessage,
        role: userMessage.role || userMessage.type || 'user', // Garantir que role está definido
        sessionId: currentSessionId
      });
      
      logger.debug('📤 User message emitted:', userMessage.id);
      
      // Prepare Claude Code query options
      let queryOptions = {
        maxTurns: maxTurns,
        includePartialMessages: true,  // Streaming real token a token
      };

      // Adicionar mensagem do usuário ao contexto da sessão
      await sessionContextManager.addToContext(currentSessionId, 'user', message);

      // Obter mensagem com contexto da conversa
      let finalPrompt = await sessionContextManager.getFormattedContext(currentSessionId, message);

      // System prompt via SDK (melhor que concatenar strings)
      if (systemPrompt) {
        queryOptions.appendSystemPrompt = systemPrompt;
      }

      // Tools
      if (allowedTools.length > 0) {
        queryOptions.allowedTools = allowedTools;
      }

      // Novos recursos do SDK via customOptions
      if (customOptions.model) queryOptions.model = customOptions.model;
      if (customOptions.fallbackModel) queryOptions.fallbackModel = customOptions.fallbackModel;
      if (customOptions.maxThinkingTokens) queryOptions.maxThinkingTokens = customOptions.maxThinkingTokens;
      queryOptions.permissionMode = customOptions.permissionMode || process.env.CLAUDE_DEFAULT_PERMISSION_MODE || 'bypassPermissions';

      // Channel-aware tool policy (config/tool-policies.js). For Socket.IO
      // chat the channel is 'web' — trusted local UI by default, but the
      // policy module gives us a single source of truth for any tightening.
      try {
        const { applyPolicy, logIfDiverged } = require('./config/tool-policies');
        const _policyResult = applyPolicy(queryOptions, { source: 'web' });
        queryOptions = _policyResult.options;
        logIfDiverged(_policyResult.diff);
      } catch (e) {
        logger.error('[tool-policy] socket.io resolve failed:', e.message);
      }

      // AbortController com timeout
      const QUERY_TIMEOUT = parseInt(process.env.QUERY_TIMEOUT) || 120000;
      currentAbortController = new AbortController();
      const timeoutId = setTimeout(() => currentAbortController.abort(), QUERY_TIMEOUT);
      queryOptions.abortController = currentAbortController;

      logger.debug('⏳ Starting Claude query:', { sessionId: currentSessionId, model: queryOptions.model || 'default' });

      socket.emit('typing_start');
      if (isThrottled()) {
        socket.emit('processing_step', {
          sessionId: currentSessionId,
          step: 'queued',
          message: 'Aguardando vaga — sistema em throttle por uso de memória.',
          timestamp: Date.now()
        });
      }
      socket.emit('processing_step', {
        sessionId: currentSessionId,
        step: 'sending',
        message: 'Enviando mensagem para o Claude...',
        data: { promptLength: finalPrompt.length, maxTurns: queryOptions.maxTurns, model: queryOptions.model || 'default' },
        timestamp: Date.now()
      });

      let assistantResponse = '';
      let streamBuffer = '';
      let responseMetadata = {};
      const messages = [];

      try {
        // Capturar stderr do processo claude para debug
        queryOptions.stderr = (data) => logger.debug('🔴 Claude stderr:', data);

        for await (const msg of query({ prompt: finalPrompt, options: queryOptions })) {
          messages.push(msg);
          logger.debug('🔄 Claude msg:', msg.type);
          
          // Emit real-time processing steps
          socket.emit('processing_step', {
            sessionId: currentSessionId,
            step: msg.type,
            message: getStepMessage(msg.type, msg),
            data: getStepData(msg),
            timestamp: Date.now()
          });
          
          // Handle different message types from Claude Code SDK
          if (msg.type === 'result') {
            // Capture final metadata
            responseMetadata = {
              cost: msg.total_cost_usd,
              duration: msg.duration_ms,
              turns: msg.num_turns,
              is_error: msg.is_error
            };
            
            if (!msg.is_error && msg.result) {
              let resultStr = extractTextContent(msg.result);

              // Processar mensagem de limite do Claude
              if (resultStr.includes('Claude AI usage limit reached|')) {
                const timestampMatch = resultStr.match(/Claude AI usage limit reached\|(\d+)/);
                if (timestampMatch) {
                  const resetTimestamp = parseInt(timestampMatch[1]);
                  const resetDate = new Date(resetTimestamp * 1000);
                  resultStr = `🕐 Seu limite será resetado: dia ${resetDate.getDate()}, ${resetDate.getHours()}h`;
                  socket.emit('typing_end');
                }
              }

              assistantResponse = resultStr;
              socket.emit('message_stream', {
                sessionId: currentSessionId,
                content: resultStr,
                fullContent: streamBuffer || resultStr
              });

            } else if (msg.is_error) {
              assistantResponse = `Error: ${msg.error || 'Unknown error occurred'}`;
              logger.error('❌ Claude error:', msg.error);
            }

          // Streaming real token a token (includePartialMessages)
          } else if (msg.type === 'stream_event' && msg.event) {
            if (msg.event.type === 'content_block_delta' && msg.event.delta?.text) {
              streamBuffer += msg.event.delta.text;
              socket.emit('message_stream', {
                sessionId: currentSessionId,
                content: msg.event.delta.text,
                fullContent: streamBuffer
              });
            }

          } else if (msg.type === 'thinking') {
            logger.debug('💭 Claude thinking...');
          } else if (msg.type === 'tool_use' || msg.type === 'tool_result') {
            logger.debug('🔧 Tool:', msg.type, msg.name || msg.tool_use_id);
          } else if (msg.type === 'assistant' && msg.message) {
            const extracted = extractTextContent(msg.message);
            if (extracted) {
              assistantResponse = extracted;
              logger.debug('📝 Assistant msg:', extracted.substring(0, 100));
            }
          }
        }

        clearTimeout(timeoutId);
        logger.debug('🏁 Claude query completed');
        
        socket.emit('processing_step', {
          sessionId: currentSessionId,
          step: 'finalizing',
          message: 'Finalizando resposta...',
          timestamp: Date.now()
        });
        
        socket.emit('typing_end');
        
        // Validar e garantir que assistantResponse é string
        if (typeof assistantResponse !== 'string') {
          logger.warn('⚠️ Non-string response, extracting text:', typeof assistantResponse);
          assistantResponse = extractTextContent(assistantResponse);
        }
        if (!assistantResponse || assistantResponse.trim() === '') {
          logger.warn('⚠️ Empty response, metadata:', responseMetadata);
          assistantResponse = "Resposta vazia do Claude. Tente reformular a pergunta.";
        }
        
        // Create assistant message
        const assistantMessage = {
          id: uuidv4(),
          type: 'assistant',
          content: assistantResponse,
          timestamp: Date.now(),
          ...responseMetadata
        };
        
        // Adicionar resposta do assistente ao contexto da sessão
        await sessionContextManager.addToContext(currentSessionId, 'assistant', assistantResponse);
        
        logger.debug('💾 Saving:', assistantMessage.id);

        // Save to session
        sessionData.messages.push(assistantMessage);
        sessionData.lastActivity = Date.now();
        sessions.set(currentSessionId, sessionData);
        
        socket.emit('message_complete', {
          ...assistantMessage,
          sessionId: currentSessionId
        });
        
      } catch (error) {
        clearTimeout(timeoutId);
        logger.error('❌ Claude query error:', error.message);
        socket.emit('typing_end');

        // Detectar tipo de erro
        let errorContent = `Erro: ${error.message}`;

        if (error.name === 'AbortError' || error.message?.includes('abort')) {
          errorContent = 'Tempo limite excedido ou mensagem cancelada.';
        } else if (isClaudeLimitError(error.message)) {
          const resetInfo = extractResetTime(error.message);
          if (resetInfo) {
            errorContent = `🕐 Limite do Claude atingido. Reset: ${resetInfo.formatted}`;
          } else {
            errorContent = `🕐 Limite do Claude atingido. Verifique /usage no Claude Code para detalhes.`;
          }
        }

        const errorMessage = {
          id: uuidv4(),
          type: 'assistant',
          content: errorContent,
          timestamp: Date.now(),
          is_error: true
        };
        
        sessionData.messages.push(errorMessage);
        sessions.set(currentSessionId, sessionData);
        
        socket.emit('error', {
          ...errorMessage,
          sessionId: currentSessionId
        });
      }
      
    } catch (error) {
      console.error('Message handling error:', error);
      
      // Send error message in the correct format
      const errorMessage = {
        id: uuidv4(),
        type: 'assistant',
        content: `Tive um problema interno processando isso. Já tô investigando.`,
        timestamp: Date.now(),
        is_error: true
      };
      
      socket.emit('error', {
        ...errorMessage,
        sessionId: data?.sessionId || 'default'
      });
    }
  });


  // Handle file analysis requests
  socket.on('analyze_file', async (data) => {
    try {
      const { content, filename, prompt = 'Analyze this code file' } = data;
      
      if (!content) {
        socket.emit('error', { error: 'No file content provided' });
        return;
      }
      
      const analysisPrompt = `${prompt}

File: ${filename}
Content:
\`\`\`
${content}
\`\`\`

Please provide a thorough analysis of this file.`;
      
      // Trigger analysis using the same message flow
      socket.emit('send_message', {
        message: analysisPrompt,
        maxTurns: 3
      });
      
    } catch (error) {
      console.error('File analysis error:', error);
      socket.emit('error', { 
        error: 'Failed to analyze file',
        details: error.message 
      });
    }
  });
  
  // Handle session management
  socket.on('load_session', (sessionId) => {
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
      socket.emit('session_loaded', sessionData);
    } else {
      socket.emit('error', { error: 'Session not found' });
    }
  });
  
  socket.on('create_session', () => {
    const newSessionId = uuidv4();
    const sessionData = {
      id: newSessionId,
      created: Date.now(),
      messages: [],
      title: 'Nova Sessão'
    };
    
    sessions.set(newSessionId, sessionData);
    socket.emit('session_created', sessionData);
  });
  
  // Handle session deletion
  socket.on('delete_session', (sessionId) => {
    console.log('🗑️ Deleting session:', sessionId);
    const deleted = sessions.delete(sessionId);
    
    if (deleted) {
      // Notify all connected clients about the deletion
      io.emit('session_deleted', {
        success: true,
        sessionId: sessionId,
        remainingSessions: sessions.size,
        timestamp: Date.now()
      });
      
      console.log('✅ Session deleted successfully:', sessionId);
    } else {
      socket.emit('session_deleted', {
        success: false,
        sessionId: sessionId,
        error: 'Session not found',
        timestamp: Date.now()
      });
      
      console.log('❌ Session not found for deletion:', sessionId);
    }
  });
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    activeConnections.delete(socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('🚀 Enhanced Claude Code SDK Server running on port', PORT);
  console.log('📋 Features enabled:');
  console.log('  • Real-time streaming chat');
  console.log('  • File upload and analysis');
  console.log('  • Session management');
  console.log('  • Conversation export');
  console.log('  • Advanced Claude Code SDK integration');
  console.log('  • WebSocket connections for real-time updates');

  // Start health monitoring
  healthChecker.startMonitoring({
    io
  }, 30000); // Check every 30 seconds
  console.log('  • Real-time metrics and monitoring');

  // Start watchdog
  watchdog.start({
    onAlert: (alert) => logger.warn(`🐕 Watchdog [${alert.level}] ${alert.message}`),
  });
  console.log('  • Health watchdog: active');

  // WhatsApp channel (opt-in)
  if (process.env.WHATSAPP_ENABLED === 'true') {
    whatsappChannel = require('./services/whatsapp/whatsapp-channel');
    connStatus.register(whatsappChannel);
    whatsappChannel.start({ io, taskRunner }).catch(err => {
      console.error('❌ WhatsApp channel failed to start:', err);
    });
    console.log('  • WhatsApp channel: enabled');

    // Health cron — alertas de saúde via WhatsApp
    healthCron.start({ whatsappChannel, watchdog, diskUsage, connStatus, logger });
    console.log('  • Health cron: active');

    // Roadmap Paraguai — avisos diários no grupo Rota Fiscal #333
    roadmapCron.start();
    console.log('  • Roadmap cron: active');

    // Automações comerciais (briefing pré-reunião + relatório semanal)
    automationCron.start();
  }

  // Cron scheduler (sempre ligado — sem cron.json = no-op)
  cronScheduler.start({ taskRunner, io });

  // Kanban (sempre ligado — DB lazy-created)
  kanban.start({ taskRunner });

  // MCP client (conecta servidores em data/mcp-servers.json)
  mcpClient.start().catch(err => console.error('MCP start failed:', err.message));

  // Plugins (data/plugins/ + ~/.hermes-mythos/plugins/)
  pluginLoader.start({ hooks: hooksService, taskRunner, app, io })
    .catch(err => console.error('Plugins start failed:', err.message));

  // Auto-rotação de sessões Claude Code (rolling window de 200 por project).
  // Roda agora + a cada 6h. Substitui o launchd plist (bootstrap falha no macOS atual).
  const { exec } = require('child_process');
  const CLEANUP_SCRIPT = path.join(__dirname, 'scripts', 'cleanup-sessions.sh');
  const runCleanup = () => {
    exec(`bash "${CLEANUP_SCRIPT}"`, { env: { ...process.env, KEEP: process.env.SESSIONS_KEEP || '200' } }, (err) => {
      if (err) console.error('⚠️  cleanup-sessions failed:', err.message);
    });
  };
  setTimeout(runCleanup, 30_000);                  // 30s após boot
  setInterval(runCleanup, 6 * 60 * 60 * 1000);     // a cada 6h
  console.log('  • Session cleanup: rolling window 200/project, every 6h');
});