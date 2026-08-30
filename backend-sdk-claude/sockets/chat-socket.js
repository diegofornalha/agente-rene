'use strict';
// sockets/chat-socket.js — todo o chat Socket.IO da UI local: send_message
// (streaming via Claude Code SDK), cancel_message, analyze_file e gestão de
// sessões in-memory. Era o io.on('connection') inline do server.js.

const { v4: uuidv4 } = require('uuid');
const { query, isThrottled } = require('../claude-query');
const logger = require('../services/logger');
const {
  sessions, activeConnections, processedMessages,
} = require('../services/chat/session-registry');
const {
  isClaudeLimitError, extractResetTime,
  getStepMessage, getStepData, extractTextContent,
} = require('../services/chat/step-formatter');

module.exports = function attach(io, { sessionContextManager }) {

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

};
