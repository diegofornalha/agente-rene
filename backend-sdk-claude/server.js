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

// In-memory session storage (in production, use Redis or database)
const sessions = new Map();
const activeConnections = new Map();
// Sistema de deduplicação de mensagens
const processedMessages = new Map();

// Referência ao canal WhatsApp pra rotas externas (POST /api/whatsapp/say)
let whatsappChannel = null;

const MESSAGE_TTL = 30000; // 30 seconds

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

// Função para detectar se um erro é de limite do Claude
function isClaudeLimitError(errorMsg) {
  if (!errorMsg) return false;
  return errorMsg.includes('Claude AI usage limit reached') ||
         errorMsg.includes('usage limit') ||
         errorMsg.includes('rate limit');
}

// Função para extrair timestamp de reset da mensagem de erro
function extractResetTime(errorMsg) {
  if (!errorMsg) return null;

  // Tentar extrair timestamp direto: "Claude AI usage limit reached|1234567890"
  let match = errorMsg.match(/Claude AI usage limit reached\|(\d+)/);
  if (!match) {
    match = errorMsg.match(/\{"type":\s*"text",\s*"text":\s*"Claude AI usage limit reached\|(\d+)"\s*\}/);
  }

  if (match) {
    const resetTimestamp = parseInt(match[1]);
    const resetDate = new Date(resetTimestamp * 1000);
    const day = resetDate.getDate();
    const hour = resetDate.getHours();
    const min = resetDate.getMinutes();
    return {
      timestamp: resetTimestamp,
      date: resetDate,
      formatted: `dia ${day}, ${hour}:${String(min).padStart(2, '0')}h`
    };
  }

  return null;
}

// Wrapper legado para compatibilidade com endpoint /api/claude-reset-info
async function getClaudeResetTime() {
  // Não spawnar processo extra — retornar null se não temos info em cache
  return null;
}

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

// Helper functions for processing step messages
function getStepMessage(stepType, msg) {
  switch (stepType) {
    case 'thinking':
      return 'Fase de raciocínio — montando plano de execução.';
    case 'tool_use':
      return `Executando ${msg.name || 'ferramenta'}: ${getToolDescription(msg.name, msg.input)}`;
    case 'tool_result':
      const success = !msg.is_error && msg.content;
      return `${msg.tool_use_id?.slice(0, 8) || 'Execução'} ${success ? 'concluída' : 'falhou'}`;
    case 'result':
      if (msg.is_error) {
        return `Erro: ${msg.error || 'Erro desconhecido'}`;
      }
      return `Resposta gerada (${msg.result?.length || 0} caracteres, ${msg.num_turns || 1} turnos)`;
    case 'streaming':
      return 'Enviando resposta...';
    case 'stream_event':
      return 'Recebendo resposta em tempo real...';
    case 'sending':
      return 'Enviando mensagem para o Claude...';
    case 'cancelled':
      return 'Mensagem cancelada.';
    case 'user':
      return 'Recebendo mensagem...';
    case 'assistant':
      return 'Claude está respondendo...';
    case 'system':
      return 'Preparando contexto...';
    default:
      return `Processando: ${stepType}`;
  }
}

function getToolDescription(toolName, input) {
  switch (toolName) {
    case 'Read':
      return `Lendo arquivo: ${input?.file_path?.split('/').pop() || 'arquivo'}`;
    case 'Write':
      return `Escrevendo arquivo: ${input?.file_path?.split('/').pop() || 'arquivo'}`;
    case 'Edit':
      return `Editando arquivo: ${input?.file_path?.split('/').pop() || 'arquivo'}`;
    case 'Bash':
      return `Executando comando: ${input?.command?.substring(0, 50) || 'comando'}${input?.command?.length > 50 ? '...' : ''}`;
    case 'Glob':
      return `Buscando arquivos: ${input?.pattern || 'padrão'}`;
    case 'Grep':
      return `Buscando conteúdo: ${input?.pattern || 'padrão'}`;
    case 'LS':
      return `Listando diretório: ${input?.path?.split('/').pop() || 'diretório'}`;
    case 'Task':
      return `Iniciando sub-agente: ${input?.description || 'tarefa'}`;
    case 'WebFetch':
      return `Acessando URL: ${input?.url || 'página web'}`;
    case 'WebSearch':
      return `Pesquisa web: ${input?.query || 'consulta'}`;
    default:
      return toolName ? `Operação ${toolName}` : 'Operação desconhecida';
  }
}

function getStepData(msg) {
  const data = { 
    type: msg.type,
    timestamp: Date.now(),
    messageId: generateShortId()
  };
  
  switch (msg.type) {
    case 'tool_use':
      data.toolName = msg.name;
      data.toolId = msg.id;
      data.toolInput = msg.input;
      data.inputSummary = getInputSummary(msg.name, msg.input);
      data.expectedOutput = getExpectedOutput(msg.name, msg.input);
      data.toolDescription = getDetailedToolDescription(msg.name);
      break;
      
    case 'tool_result':
      data.toolUseId = msg.tool_use_id;
      data.hasError = !!msg.is_error;
      data.contentLength = msg.content?.length;
      data.contentType = getContentType(msg.content);
      data.errorDetails = msg.is_error ? msg.content : null;
      data.executionStatus = msg.is_error ? 'failed' : 'success';
      data.outputSummary = getOutputSummary(msg.content);
      break;
      
    case 'result':
      data.isError = msg.is_error;
      data.duration = msg.duration_ms;
      data.cost = msg.total_cost_usd;
      data.turns = msg.num_turns;
      data.inputTokens = msg.input_tokens;
      data.outputTokens = msg.output_tokens;
      data.cacheReads = msg.cache_read_tokens;
      data.cacheWrites = msg.cache_write_tokens;
      
      if (msg.result) {
        data.responseLength = msg.result.length;
        data.responseWords = msg.result.split(/\s+/).length;
        data.responseLines = msg.result.split('\n').length;
        data.hasCodeBlocks = /```/.test(msg.result);
        data.hasMarkdown = /[#*`\[\]]/.test(msg.result);
      }
      
      if (msg.error) {
        data.errorType = getErrorType(msg.error);
        data.errorMessage = msg.error;
      }
      break;
      
    case 'thinking':
      data.cognitiveLoad = 'processing';
      data.analysisPhase = 'understanding_request';
      data.strategizing = true;
      break;
      
    default:
      data.unknownType = true;
      break;
  }
  
  return data;
}

function generateShortId() {
  return Math.random().toString(36).substr(2, 8);
}

function getInputSummary(toolName, input) {
  if (!input) return 'No input provided';
  
  switch (toolName) {
    case 'Read':
      return `File: ${input.file_path?.split('/').pop()} (${input.limit ? `first ${input.limit} lines` : 'entire file'})`;
    case 'Write':
      return `File: ${input.file_path?.split('/').pop()} (${input.content?.length || 0} characters)`;
    case 'Edit':
      return `File: ${input.file_path?.split('/').pop()} (${input.old_string?.length || 0} → ${input.new_string?.length || 0} chars)`;
    case 'Bash':
      return `Command: ${input.command} ${input.timeout ? `(timeout: ${input.timeout}ms)` : ''}`;
    case 'Glob':
      return `Pattern: ${input.pattern} in ${input.path || 'current directory'}`;
    case 'Grep':
      return `Pattern: /${input.pattern}/ in ${input.include || 'all files'}`;
    default:
      return Object.keys(input).map(k => `${k}: ${String(input[k]).substring(0, 30)}`).join(', ');
  }
}

function getExpectedOutput(toolName, input) {
  switch (toolName) {
    case 'Read':
      return 'File contents with line numbers';
    case 'Write':
      return 'File creation confirmation';
    case 'Edit':
      return 'File modification confirmation';
    case 'Bash':
      return 'Command output and exit status';
    case 'Glob':
      return 'List of matching file paths';
    case 'Grep':
      return 'Files containing the search pattern';
    case 'LS':
      return 'Directory listing with file details';
    case 'Task':
      return 'Sub-agent execution results';
    default:
      return 'Tool-specific output';
  }
}

function getDetailedToolDescription(toolName) {
  switch (toolName) {
    case 'Read':
      return 'Reads file contents from the filesystem with optional line limits and offsets';
    case 'Write':
      return 'Creates or overwrites files with provided content';
    case 'Edit':
      return 'Performs exact string replacements in existing files';
    case 'Bash':
      return 'Executes shell commands in a persistent session with timeout controls';
    case 'Glob':
      return 'Searches for files matching glob patterns with modification time sorting';
    case 'Grep':
      return 'Searches file contents using regular expressions with file filtering';
    case 'LS':
      return 'Lists directory contents with detailed file information';
    case 'Task':
      return 'Spawns independent agent instances for complex subtasks';
    case 'WebFetch':
      return 'Fetches and processes web content with AI analysis';
    case 'WebSearch':
      return 'Performs web searches with result filtering and ranking';
    default:
      return 'Specialized tool for specific operations';
  }
}

function getContentType(content) {
  if (!content) return 'empty';
  if (typeof content !== 'string') return typeof content;
  
  if (content.includes('Error:') || content.includes('error:')) return 'error_message';
  if (content.match(/^\s*\{.*\}\s*$/s)) return 'json';
  if (content.match(/^\s*<.*>\s*$/s)) return 'xml_html';
  if (content.includes('```')) return 'code_block';
  if (content.split('\n').length > 10) return 'multiline_text';
  
  return 'text';
}

// Extrai texto de qualquer formato de resposta do Claude Code SDK
function extractTextContent(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    return data
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('\n');
  }
  if (typeof data === 'object') {
    if (data.type === 'text' && data.text) return data.text;
    if (data.content) return extractTextContent(data.content);
    if (data.message) return extractTextContent(data.message);
    if (data.text) return String(data.text);
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}

function getOutputSummary(content) {
  if (!content) return 'No output';
  
  const lines = content.split('\n').length;
  const words = content.split(/\s+/).length;
  const chars = content.length;
  
  let summary = `${chars} chars, ${words} words, ${lines} lines`;
  
  if (content.includes('Error:')) summary += ' (contains errors)';
  if (content.includes('```')) summary += ' (contains code)';
  if (content.match(/\.(js|ts|py|java|cpp|c|go|rs|php|rb)$/)) summary += ' (source code)';
  
  return summary;
}

function getErrorType(error) {
  if (!error) return 'unknown';
  
  const errorStr = error.toString().toLowerCase();
  
  if (errorStr.includes('timeout')) return 'timeout';
  if (errorStr.includes('permission')) return 'permission_denied';
  if (errorStr.includes('not found') || errorStr.includes('enoent')) return 'file_not_found';
  if (errorStr.includes('syntax')) return 'syntax_error';
  if (errorStr.includes('network') || errorStr.includes('fetch')) return 'network_error';
  if (errorStr.includes('memory') || errorStr.includes('oom')) return 'memory_error';
  
  return 'general_error';
}


// ── llms.txt público (sem auth) — índice canônico do mythos ──
app.get('/llms.txt', async (req, res) => {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  const md = await llmsIndex.get();
  res.send(md);
});

app.get('/llms-full.txt', async (req, res) => {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  const md = await llmsIndex.getFull();
  res.send(md);
});

// Leads Rota Fiscal — CRUD de registros por pessoa
app.use('/api/leads/rota-fiscal', rotaFiscalLeads.criarRouter());

// Endpoint OpenAI-compatível expondo o Claude Code (assinatura) como modelo
// "claudecode" — /v1/chat/completions + /v1/models. Usado pelo provider custom
// do hermes-webui. Ver services/openai-compat.js.
require('./services/openai-compat').mount(app);

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Use cached status if available and recent
    const cached = healthChecker.getCachedStatus();
    if (cached && !req.query.force) {
      return res.json(cached);
    }

    // Perform full health check
    const healthStatus = await healthChecker.performFullCheck({
      io
    });

    // Set appropriate HTTP status code based on health
    const httpStatus = healthStatus.status === 'unhealthy' ? 503 : 
                       healthStatus.status === 'degraded' ? 200 : 200;

    res.status(httpStatus).json(healthStatus);
  } catch (error) {
    console.error('❌ [HEALTH] Health check error:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Watchdog endpoint
app.get('/api/watchdog', (req, res) => {
  res.json(watchdog.status());
});

// Disk usage endpoint
app.get('/api/disk-usage', async (req, res) => {
  try {
    const report = await diskUsage.check();
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Connection status endpoint
app.get('/api/connection-status', (req, res) => {
  res.json(connStatus.status());
});

// Force reconnect endpoint
app.post('/api/connection-status/reconnect', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const result = await connStatus.forceReconnect();
  res.json(result);
});

// Auth do plano Claude (authDown guard) — status e probe manual
app.get('/api/auth-status', (req, res) => {
  res.json(require('./services/health/auth-monitor').status());
});

app.post('/api/auth-status/probe', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const authMonitor = require('./services/health/auth-monitor');
  await authMonitor._probe();
  res.json(authMonitor.status());
});

// Health cron status & trigger
app.get('/api/health-cron', (req, res) => {
  res.json(healthCron.status());
});

app.post('/api/health-cron/check', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  await healthCron.runNow();
  res.json({ ok: true, ...healthCron.status() });
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const content = await fs.readFile(filePath, 'utf8');
    
    // Clean up uploaded file after reading
    await fs.remove(filePath);
    
    res.json({
      success: true,
      filename: req.file.originalname,
      content: content,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({ 
      error: 'Failed to process file',
      details: error.message 
    });
  }
});

// Export conversation endpoint
app.post('/api/export', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const { messages, format = 'markdown' } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages data' });
    }
    
    let content = '';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    if (format === 'markdown') {
      content += `# Claude UI Chat Agent SDK Export\n\n`;
      content += `Generated on: ${new Date().toLocaleString()}\n\n`;
      content += `---\n\n`;
      
      messages.forEach((msg, index) => {
        const role = msg.type === 'user' ? 'User' : 'Claude';
        content += `## ${role} (${new Date(msg.timestamp).toLocaleTimeString()})\n\n`;
        content += `${msg.content}\n\n`;
        
        if (msg.type === 'assistant' && (msg.cost || msg.duration || msg.turns)) {
          content += `*Metadata: `;
          const meta = [];
          if (msg.cost) meta.push(`Cost: $${msg.cost.toFixed(4)}`);
          if (msg.duration) meta.push(`Duration: ${msg.duration.toFixed(0)}ms`);
          if (msg.turns) meta.push(`Turns: ${msg.turns}`);
          content += meta.join(' • ') + '*\n\n';
        }
        
        content += `---\n\n`;
      });
    } else if (format === 'json') {
      content = JSON.stringify({
        export_date: new Date().toISOString(),
        message_count: messages.length,
        messages: messages
      }, null, 2);
    }
    
    const filename = `claude-ui-agent-${timestamp}.${format === 'json' ? 'json' : 'md'}`;
    
    res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export conversation' });
  }
});

const requireDevMode = (req, res, next) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Debug endpoints disabled in production' });
  }
  next();
};

app.get('/api/debug/session/:sessionId', requireDevMode, async (req, res) => {
  const { sessionId } = req.params;

  try {
    const sessionData = sessions.get(sessionId);
    const contextFormatted = await sessionContextManager.getFormattedContext(sessionId, "[PRÓXIMA MENSAGEM]");
    const stats = await sessionContextManager.getStats();

    res.json({
      sessionId,
      exists: !!sessionData,
      messageCount: sessionData ? sessionData.messages.length : 0,
      messages: sessionData ? sessionData.messages.slice(-20) : [],
      contextPreview: contextFormatted,
      stats,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/dialogs', requireDevMode, async (req, res) => {
  try {
    const dialogs = [];

    for (const [sessionId, sessionData] of sessions.entries()) {
      const lastMessage = sessionData.messages[sessionData.messages.length - 1];

      dialogs.push({
        sessionId,
        title: sessionData.title || 'Sessão sem título',
        messageCount: sessionData.messages.length,
        createdAt: sessionData.createdAt,
        lastActivity: sessionData.lastActivity,
        lastMessage: lastMessage ? {
          type: lastMessage.type,
          preview: lastMessage.content ? lastMessage.content.substring(0, 100) + '...' : '',
          timestamp: lastMessage.timestamp
        } : null
      });
    }

    res.json({
      activeDialogs: dialogs.length,
      dialogs,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para obter informações do próximo reset do Claude
app.get('/api/claude-reset-info', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    // Tentar obter info do timestamp real do Claude
    const resetInfo = await getClaudeResetTime();
    
    if (resetInfo && resetInfo.timestamp) {
      res.json({
        success: true,
        resetTimestamp: resetInfo.timestamp,
        resetDate: resetInfo.date,
        formatted: resetInfo.formatted
      });
    } else {
      // Se não tem info do Claude, verificar se temos salvo quando o limite foi atingido
      res.json({
        success: false,
        message: 'No reset information available'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Session management endpoints
app.get('/api/sessions', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
    id: id,
    created: data.created,
    lastActivity: data.lastActivity,
    messageCount: data.messages ? data.messages.length : 0,
    title: data.title || `Session ${id.slice(0, 8)}...`
  }));
  
  res.json({ sessions: sessionList });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const sessionData = sessions.get(req.params.sessionId);
  if (!sessionData) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json(sessionData);
});

app.delete('/api/sessions/:sessionId', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const deleted = sessions.delete(req.params.sessionId);
  res.json({ success: deleted });
});

// ══════════════════════════════════════════════
// Task Runner — REST Endpoints
// ══════════════════════════════════════════════

// ── Skill Curator ──────────────────────────────────────────────────────────
app.post('/api/curator/run', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const curator = require('./services/skills/skill-curator');
    const result = await curator.run(taskRunner);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/curator/reports', (req, res) => {
  const curator = require('./services/skills/skill-curator');
  res.json({ reports: curator.listReports() });
});

app.get('/api/curator/report/:iso', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { iso } = req.params;
  const REPORT_DIR = path.join(__dirname, 'data', 'curator');
  const f = path.join(REPORT_DIR, `REPORT-${iso}.md`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'report not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.send(fs.readFileSync(f, 'utf8'));
});

app.get('/api/curator/report', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const f = path.join(__dirname, 'data', 'skill-curator-report.json');
    if (!fs.existsSync(f)) return res.json({ report: null });
    res.json({ report: fs.readJsonSync(f) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MCP servers ───────────────────────────────────────────────────────────
app.get('/api/mcp/servers', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json({ configured: mcpClient.listConfigured(), connected: mcpClient.listConnected() });
});
app.post('/api/mcp/:server/call', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { tool, args } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool obrigatório' });
  try {
    const result = await mcpClient.callTool(req.params.server, tool, args || {});
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Skills Hub local (Hermes upstream) ──────────────────────────────────
skillsHub.routes(app);

// ── Observability ─────────────────────────────────────────────────────────
// Prometheus-like metrics (sem auth — intenção).
app.get('/api/metrics', async (req, res) => {
  if (req.headers.accept?.includes('text/plain')) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(metrics.toPrometheusText());
  }
  res.json(metrics.summary());
});

// Lista hooks ativos (sem auth — intenção).
app.get('/api/hooks', (req, res) => {
  res.json(hooksService.list());
});

// ── Sessions search (FTS5) ────────────────────────────────────────────────
app.get('/api/sessions/search', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { q, limit, source, status } = req.query;
  if (!q) return res.status(400).json({ error: 'q (query) é obrigatório' });
  try {
    const results = sessionsSearch.search(q, {
      limit: parseInt(limit) || 20, source, status,
    });
    res.json({ results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── WhatsApp envio direto (texto ou áudio TTS) ────────────────────────────
app.post('/api/whatsapp/say', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { jid, text, voice } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: 'jid and text are required' });
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    if (voice) await whatsappChannel.sendVoice(jid, text);
    else await whatsappChannel.sendText(jid, text);
    res.json({ success: true, mode: voice ? 'voice' : 'text' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/send-video — envia um MP4 local como mídia no WhatsApp.
app.post('/api/whatsapp/send-video', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { jid, videoPath, caption } = req.body || {};
  if (!jid || !videoPath) return res.status(400).json({ error: 'jid and videoPath are required' });
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const buf = await fs.readFile(videoPath);
    await whatsappChannel.sendVideo(jid, buf, caption);
    res.json({ success: true, bytes: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/send-document — envia documento (PDF, DOCX, etc) via WhatsApp.
app.post('/api/whatsapp/send-document', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { jid, filePath, filename, mimetype, caption } = req.body || {};
  if (!jid || !filePath) return res.status(400).json({ error: 'jid and filePath are required' });
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const buf = await fs.readFile(filePath);
    const fname = filename || require('path').basename(filePath);
    const mime = mimetype || (filePath.endsWith('.pdf') ? 'application/pdf' : filePath.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/octet-stream');
    await whatsappChannel.sendDocument(jid, buf, fname, mime, caption);
    res.json({ success: true, bytes: buf.length, filename: fname });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/whatsapp/context/:jid — limpa histórico de conversa (conversation-history + sessionContext).
app.delete('/api/whatsapp/context/:jid', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { jid } = req.params;
  const cleared = { convHistory: false, sessionContext: false };

  // 1. conversation-history (multi-turno wa:jid)
  try {
    convHistory.clearSession('wa', jid);
    cleared.convHistory = true;
  } catch (e) {
    logger.error({ err: e }, `clear convHistory failed for ${jid}`);
  }

  // 2. sessionContext (prompt context)
  try {
    sessionContextManager.clearContext(jid);
    cleared.sessionContext = true;
  } catch (e) {
    logger.error({ err: e }, `clear sessionContext failed for ${jid}`);
  }

  logger.info(`🧹 [CONTEXT] Cleared WhatsApp context for ${jid} — conv=${cleared.convHistory} session=${cleared.sessionContext}`);
  res.json({ success: true, jid, cleared });
});

// GET /api/whatsapp/context/stats — estatísticas dos contextos ativos.
app.get('/api/whatsapp/context/stats', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json({
    convHistory: convHistory.stats(),
    sessionContext: sessionContextManager.getStats(),
  });
});

// GET /api/whatsapp/inbound-image — caminho da última imagem recebida.
app.get('/api/whatsapp/inbound-image', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const imagePath = await whatsappChannel.getLatestInboundImage();
    res.json({ imagePath: imagePath || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/groups — lista todos os grupos em que o bot participa.
app.get('/api/whatsapp/groups', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const groups = await whatsappChannel.listGroups();
    res.json({ total: groups.length, groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/dm-allowlist — lista a allowlist de DM (env + runtime + efetiva).
app.get('/api/whatsapp/dm-allowlist', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  res.json(whatsappChannel.listDmAllowed());
});

// POST /api/whatsapp/dm-allow — libera um número OU LID pra conversar por DM.
// body: { number } (aceita +55…, com pontuação, ou um LID; é normalizado pra dígitos)
app.post('/api/whatsapp/dm-allow', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { number } = req.body || {};
  if (!number) return res.status(400).json({ error: 'number is required' });
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  const r = whatsappChannel.addDmAllowed(number);
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/whatsapp/dm-disallow — revoga um número/LID adicionado em runtime.
// body: { number }  (não remove entradas fixas do .env)
app.post('/api/whatsapp/dm-disallow', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { number } = req.body || {};
  if (!number) return res.status(400).json({ error: 'number is required' });
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  const r = whatsappChannel.removeDmAllowed(number);
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/whatsapp/create-group — cria grupo e retorna metadata.
// body: { subject, participants?: string[] }
app.post('/api/whatsapp/create-group', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { subject, participants } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'subject é obrigatório' });
    const meta = await whatsappChannel.createGroup(subject, participants || []);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/group-open — marca um grupo como observado + aberto (responde
// a TODOS os membros, sem precisar de @), em RUNTIME e sem reiniciar o backend.
// body: { jid, open?: boolean = true, name? }
app.post('/api/whatsapp/group-open', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  const { jid, open = true, name } = req.body || {};
  if (!jid) return res.status(400).json({ error: 'jid é obrigatório' });
  try {
    whatsappChannel.addObservedGroup(jid, name, { open });
    res.json({ ok: true, jid, open });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/group-info/:jid — metadata do grupo + resolve LID→telefone via USync.
// Útil pra descobrir telefones de participantes que só aparecem como `@lid`.
app.get('/api/whatsapp/group-info/:jid', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const info = await whatsappChannel.getGroupInfo(req.params.jid);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/resolve/:phone — telefone → { exists, jid, lid } via
// onWhatsApp + mapeamento LID↔PN. Cruza com participantes `@lid` dos grupos.
app.get('/api/whatsapp/resolve/:phone', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const info = await whatsappChannel.resolvePhone(req.params.phone);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/group-info/:jid/invite — link de convite do grupo (bot precisa ser admin).
// Útil quando addParticipants falha por account_reachout_restricted.
app.get('/api/whatsapp/group-info/:jid/invite', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const link = await whatsappChannel.getGroupInviteLink(req.params.jid);
    res.json(link);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/group-join — entra num grupo via invite code. body: { inviteCode }
app.post('/api/whatsapp/group-join', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { inviteCode } = req.body || {};
    if (!inviteCode) return res.status(400).json({ error: 'inviteCode é obrigatório' });
    const result = await whatsappChannel.acceptGroupInvite(inviteCode);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/whatsapp/group-info/:jid/subject — renomeia grupo. body: { subject }
app.patch('/api/whatsapp/group-info/:jid/subject', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { subject } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'subject é obrigatório' });
    const out = await whatsappChannel.setGroupSubject(req.params.jid, subject);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/whatsapp/group-info/:jid/description — atualiza descrição. body: { description }
app.patch('/api/whatsapp/group-info/:jid/description', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { description } = req.body || {};
    if (!description) return res.status(400).json({ error: 'description é obrigatório' });
    const out = await whatsappChannel.setGroupDescription(req.params.jid, description);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/group-info/:jid/participants — body: { participants: [...], action: add|remove|promote|demote }
app.post('/api/whatsapp/group-info/:jid/participants', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { participants, action } = req.body || {};
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'participants[] obrigatório' });
    }
    if (!action) return res.status(400).json({ error: 'action obrigatório (add|remove|promote|demote)' });
    const out = await whatsappChannel.updateGroupParticipants(req.params.jid, participants, action);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/profile-photo — troca a foto de perfil do bot.
// body: { imagePath? } — sem imagePath, usa a última imagem recebida no WhatsApp.
app.post('/api/whatsapp/profile-photo', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    let imagePath = req.body && req.body.imagePath;
    if (!imagePath) imagePath = await whatsappChannel.getLatestInboundImage();
    if (!imagePath) {
      return res.status(404).json({ error: 'nenhuma imagem disponível — envie uma imagem no WhatsApp ou passe imagePath' });
    }
    const r = await whatsappChannel.setProfilePhoto(imagePath);
    res.json({ ...r, imagePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/profile-name — troca o nome de perfil do bot.
app.post('/api/whatsapp/profile-name', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  if (!whatsappChannel) return res.status(503).json({ error: 'WhatsApp channel not enabled' });
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'campo "name" obrigatório' });
    const r = await whatsappChannel.setProfileName(name);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HeyGen (avatares, vozes, geração de vídeo) — API v2/v1 ────────────────
app.get('/api/heygen/health', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(await heygen.health());
});

app.get('/api/heygen/avatars', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.listarAvatares());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/heygen/voices', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json({ voices: await heygen.listarVozes() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/heygen/videos', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.listarVideos({ limit: Number(req.query.limit) || 20, token: req.query.token }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/heygen/videos — gera vídeo (assíncrono → { video_id }).
// body: { avatarId?, voiceId?, script?, audioAssetId?, audioUrl?, avatarStyle?, dimension?, background?, title? }
app.post('/api/heygen/videos', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.criarVideo(req.body || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/heygen/videos/:id', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.getStatus(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/heygen/videos/:id', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    res.json(await heygen.cancelarVideo(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/heygen/reels — pipeline E2E de Reels vertical 9:16 (720×1280):
// roteiro → ElevenLabs TTS → uploadAsset → criarVideo → poll → baixarMp4
// → [acelerar ffmpeg]. Síncrono, leva ~70–120s. Opcional: entrega no WhatsApp.
// body: { roteiro, speed?, titulo?, avatarId?, voiceId?, sendTo?, caption? }
app.post('/api/heygen/reels', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { roteiro, speed, titulo, avatarId, voiceId, sendTo, caption } = req.body || {};
  if (!roteiro) return res.status(400).json({ error: 'roteiro is required' });
  req.setTimeout(0); // o pipeline pode levar minutos — sem timeout de resposta
  try {
    const r = await heygenReels.gerarReels({ roteiro, speed, titulo, avatarId, voiceId });
    let delivered = null;
    if (sendTo) {
      if (!whatsappChannel) {
        delivered = { ok: false, error: 'WhatsApp channel not enabled' };
      } else {
        const buf = await fs.readFile(r.mp4Path);
        await whatsappChannel.sendVideo(sendTo, buf, caption || titulo);
        delivered = { ok: true, jid: sendTo, bytes: buf.length };
      }
    }
    res.json({ ...r, delivered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Kanban (multi-agent) ──────────────────────────────────────────────────
app.get('/api/kanban/cards', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json({ cards: kanban.listCards({ board: req.query.board, status: req.query.status }) });
});
app.post('/api/kanban/cards', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json({ success: true, card: kanban.createCard(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kanban/cards/:id/move', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(kanban.moveCard(req.params.id, req.body.status)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kanban/cards/:id/dispatch', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(kanban.dispatchCard(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/kanban/cards/:id', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(kanban.deleteCard(req.params.id));
});

// ── Cron Jobs ─────────────────────────────────────────────────────────────
app.get('/api/cron', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json({ jobs: cronScheduler.list() });
});

app.post('/api/cron', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { schedule, prompt, source, tags } = req.body || {};
  if (!schedule || !prompt) return res.status(400).json({ error: 'schedule + prompt obrigatórios' });
  try {
    const def = cronScheduler.add({ schedule, prompt, source, tags });
    res.json({ success: true, job: def });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/cron/:id', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(cronScheduler.remove(req.params.id));
});

// ── Automações comerciais ───────────────────────────────────────────────
const briefingRunner = require('./services/automations/briefing-pre-reuniao');
const relatorioRunner = require('./services/automations/relatorio-semanal');

app.post('/api/automations/briefing', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const result = await briefingRunner.run();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/automations/relatorio', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const result = await relatorioRunner.run();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tasks — submete tarefa autônoma. Aceita campo `agent` opcional
// pra rodar via subagent do Claude Code (~/.claude/agents/<name>.md). Quando
// presente, o prompt é envolvido em instrução pro Task tool e allowedTools
// fica restrito a ['Task'].
app.post('/api/tasks', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { prompt, workspace, systemPrompt, maxTurns, model, tags, source, agent } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const task = taskRunner.createTask({ prompt, workspace, systemPrompt, maxTurns, model, tags, source, agent });
  res.json({ success: true, task: _sanitizeTask(task) });
});

// GET /api/tasks — listar tasks
app.get('/api/tasks', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { status, source, limit } = req.query;
  const list = taskRunner.listTasks({ status, source, limit: parseInt(limit) || 50 });
  res.json({ tasks: list.map(_sanitizeTask) });
});

// GET /api/tasks/:id — detalhes de uma task
app.get('/api/tasks/:id', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const task = taskRunner.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(_sanitizeTask(task));
});

// DELETE /api/tasks/:id — cancelar task
app.delete('/api/tasks/:id', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const cancelled = taskRunner.cancelTask(req.params.id);
  res.json({ success: cancelled });
});

// DELETE /api/tasks — cancelar todas as tasks (queued + running)
app.delete('/api/tasks', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const queuedOnly = req.query.scope === 'queued';
  const count = queuedOnly ? taskRunner.cancelAllQueued() : taskRunner.cancelAll();
  res.json({ success: true, cancelled: count });
});

// POST /api/tasks/:id/retry — reenviar task que falhou
app.post('/api/tasks/:id/retry', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const original = taskRunner.getTask(req.params.id);
  if (!original) return res.status(404).json({ error: 'Task not found' });
  if (!['error', 'cancelled'].includes(original.status)) {
    return res.status(400).json({ error: `Cannot retry task with status: ${original.status}` });
  }
  const task = taskRunner.createTask({
    prompt: original.prompt,
    workspace: original.workspace,
    systemPrompt: original.systemPrompt,
    maxTurns: original.maxTurns,
    model: original.model,
    tags: original.tags,
    source: original.source,
  });
  res.json({ success: true, task: _sanitizeTask(task) });
});

// POST /api/translate-instagram — traduz post do Instagram e publica nas 3 contas
app.post('/api/translate-instagram', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { url, to, message_id, rebrand_name, rebrand_handle, rebrand_photo, mode } = req.body;
  if (!url || !to) {
    return res.status(400).json({ error: 'url and to (LID) are required' });
  }

  // Extrair shortcode da URL pra criar pasta isolada
  const scMatch = url.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
  const shortcode = scMatch ? scMatch[1] : `post_${Date.now()}`;
  const workDir = `${RENE_WS}/media/jobs/${shortcode}`;
  const scriptsDir = `${RENE_WS}/scripts`;
  const igDir = `${RENE_WS}/scripts/instagram`;

  // mode: "translate" (default) ou "rebrand" (só troca nome/handle/foto)
  const isRebrand = mode === 'rebrand' && rebrand_name && rebrand_handle;

  let imageStep;
  if (isRebrand) {
    const photoFlag = rebrand_photo ? ` --photo "${rebrand_photo}"` : '';
    imageStep = `2. Para CADA imagem baixada em ${workDir}/images/ (ig_*_.jpg), customizar:
cd ${scriptsDir} && uv run rebrand-image.py -i ARQUIVO_ORIGINAL -f ${workDir}/translated/NOME_ptbr.png --name "${rebrand_name}" --handle "${rebrand_handle}"${photoFlag}`;
  } else {
    imageStep = `2. Para CADA imagem baixada em ${workDir}/images/ (ig_*_.jpg), traduzir:
cd ${scriptsDir} && uv run translate-image.py -i ARQUIVO_ORIGINAL -f ${workDir}/translated/NOME_ptbr.png`;
  }

  let captionStep;
  if (isRebrand) {
    captionStep = `3. Ler a legenda em ${workDir}/images/ig_${shortcode}_caption.txt. Substituir @ do autor por "${rebrand_handle}". Adaptar CTA.`;
  } else {
    captionStep = `3. Ler a legenda em ${workDir}/images/ig_${shortcode}_caption.txt e traduzir para PT-BR. Adaptar CTA (ex: "Comenta CREAR" → "Comenta claude").`;
  }

  const prompt = `${isRebrand ? 'Customiza' : 'Traduza'} o post do Instagram e publica nas 3 contas.

IMPORTANTE: Todos os arquivos ficam na pasta isolada ${workDir}/

0. Criar pastas:
mkdir -p ${workDir}/images ${workDir}/translated

1. Baixar imagens para a pasta isolada:
cd ${scriptsDir} && DOWNLOAD_DIR=${workDir}/images uv run download-instagram.py "${url}"
Se o script não suportar DOWNLOAD_DIR, mover os arquivos: mv ${RENE_WS}/media/images/ig_${shortcode}* ${workDir}/images/

${imageStep}

${captionStep}

4. Publicar nas 3 contas do Instagram (uma de cada vez, usar caminhos ABSOLUTOS das imagens em ${workDir}/translated/):
cd ${igDir} && python3 post.py ${workDir}/translated/ig_${shortcode}_1_ptbr.png [${workDir}/translated/ig_${shortcode}_2_ptbr.png ...] "LEGENDA_TRADUZIDA"
cd ${igDir} && python3 post.py --account agentesintegrados ${workDir}/translated/ig_${shortcode}_1_ptbr.png [...] "LEGENDA_TRADUZIDA"
cd ${igDir} && python3 post.py --account openclawde ${workDir}/translated/ig_${shortcode}_1_ptbr.png [...] "LEGENDA_TRADUZIDA"
(post.py converte PNG→JPG automaticamente e limita a 10 imagens)

5. Gerar PDF:
python3 -c "
from PIL import Image; import os, glob, re
base = '${workDir}/translated'
files = sorted(glob.glob(os.path.join(base, 'ig_${shortcode}_*_ptbr.png')), key=lambda f: int(re.search(r'_(\\d+)_ptbr', f).group(1)))
imgs = [Image.open(f).convert('RGB') for f in files]
out = os.path.join(base, '${shortcode}_completo.pdf')
imgs[0].save(out, save_all=True, append_images=imgs[1:])
print(out)
"

6. Postar o PDF como documento/carrossel no LinkedIn:
cd ${RENE_WS}/scripts/linkedin && python3 linkedin_poster.py post "LEGENDA_TRADUZIDA" --doc ${workDir}/translated/${shortcode}_completo.pdf

7. Notificar o usuário que finalizou (respondendo a mensagem original):
curl -s -X POST http://127.0.0.1:18790/api/send-message -H "Content-Type: application/json" -d '{"to": "${to}", "text": "Finalizado ✅"${message_id ? `, "reply_to": "${message_id}"` : ''}}'`;

  const task = taskRunner.createTask({
    prompt,
    workspace: scriptsDir,
    tags: ['instagram', 'translate'],
    source: 'hermes',
    maxTurns: 80,
  });
  res.json({ success: true, taskId: task.id, status: task.status });
});

// POST /api/instagram-stories — publica stories nas 3 contas
app.post('/api/instagram-stories', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { images, text, to } = req.body;
  if (!images || !images.length) {
    return res.status(400).json({ error: 'images array is required' });
  }

  const igDir = `${RENE_WS}/scripts/instagram`;
  const imageList = images.map(i => `"${i}"`).join(' ');

  const prompt = `Publique stories nas 3 contas do Instagram.

1. Postar em todas as contas:
cd ${igDir} && python3 story.py --all ${imageList}

${to ? `2. Notificar o usuário:
curl -s -X POST http://127.0.0.1:18790/api/send-message -H "Content-Type: application/json" -d '{"to": "${to}", "text": "Stories publicados nas 3 contas!"}'` : ''}`;

  const task = taskRunner.createTask({
    prompt,
    workspace: igDir,
    tags: ['instagram', 'stories'],
    source: 'hermes',
    maxTurns: 20,
  });
  res.json({ success: true, taskId: task.id, status: task.status });
});

// POST /api/translate-image — traduz uma imagem avulsa e envia via WhatsApp
app.post('/api/translate-image', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { file, to, lang } = req.body;
  if (!file || !to) {
    return res.status(400).json({ error: 'file and to (LID) are required' });
  }
  const targetLang = lang || 'português brasileiro';
  const prompt = `Traduza a imagem para ${targetLang} e envie pro usuário:

1. Traduzir a imagem:
cd ${RENE_WS}/scripts && uv run translate-image.py -i "${file}" -f "${RENE_WS}/media/translated/$(require('path').basename('${file}', require('path').extname('${file}'))}_ptbr.png"

2. Enviar a imagem traduzida:
curl -s -X POST http://127.0.0.1:18790/api/send-image -H "Content-Type: application/json" -d '{"to": "${to}", "file": "${RENE_WS}/media/translated/NOME_ptbr.png"}'

Substituir NOME pelo nome do arquivo sem extensão.`;

  const task = taskRunner.createTask({
    prompt,
    workspace: `${RENE_WS}/scripts`,
    tags: ['instagram', 'translate'],
    source: 'hermes',
    maxTurns: 10,
  });
  res.json({ success: true, taskId: task.id, status: task.status });
});

// POST /api/autonomous/start — iniciar modo autônomo
app.post('/api/autonomous/start', express.json(), (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const intervalMin = parseInt(req.body.intervalMin || 60);
  taskRunner.startAutonomous(io, intervalMin * 60 * 1000);
  res.json({ success: true, intervalMin });
});

// POST /api/autonomous/stop — parar modo autônomo
app.post('/api/autonomous/stop', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  taskRunner.stopAutonomous();
  res.json({ success: true });
});

function _bearerAuth(req, res) {
  const expected = process.env.API_BEARER_SECRET
    || process.env.WEBHOOK_CRM_SECRET
    || process.env.WEBHOOK_READAI_SECRET;
  if (!expected) {
    res.status(500).json({ ok: false, error: 'API_BEARER_SECRET nao configurado' });
    return false;
  }
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(presented), b = Buffer.from(expected);
  const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}
// ── PDF filler — preenche templates DETRAN sobrepondo texto no PDF original ──
app.post('/api/preencher/declaracao-residencia', express.json(), async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const { fillDeclaracao } = require('./services/pdf-filler/declaracao-residencia');
    const debug = req.query.debug === '1' || req.body?.debug === true;
    const pdfBytes = await fillDeclaracao(req.body || {}, { debug });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="declaracao-residencia-preenchida.pdf"');
    res.send(pdfBytes);
  } catch (err) {
    logger.error('❌ pdf-filler error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/skills/run', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const result = await require('./services/skills/run-skill').handle(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Agents runner — dispara subagent do Claude Code via Task tool ──
// Diferente de /skills/run: invoca um agente .md em ~/.claude/agents/ usando
// prompt instrutivo + allowedTools:['Task']. Whitelist em services/agents/run-agent.js.
app.post('/api/agents/run', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const result = await require('./services/agents/run-agent').handle(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/agents — lista agentes disponíveis via HTTP (já filtrados por HTTP_DENY)
app.get('/api/agents', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const { listAgents } = require('./services/agents/run-agent');
    res.json({ ok: true, agents: listAgents() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Role-Play Comercial — treino de consultores contra personas de lead ──
// MVP em texto: consultor conversa com o Hiperagente-Lead e um Hiperagente
// avaliador pontua pela rubrica do Playbook. Lógica em services/roleplay/.
const roleplay = require('./services/roleplay');

app.get('/api/roleplay/personas', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(roleplay.listPersonas());
});

app.post('/api/roleplay/start', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(await roleplay.start(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/roleplay/turn', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(await roleplay.turn(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/roleplay/end', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(roleplay.end(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/roleplay/evaluate', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try { res.json(await roleplay.evaluate(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/roleplay/sessions', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(roleplay.listSessions());
});

app.get('/api/roleplay/session/:id', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  res.json(roleplay.getSession(req.params.id));
});

// ─── Google OAuth2 ───────────────────────────────────────────────────────────
const googleAuth = require('./services/google/google-auth');
const googleCalendar = require('./services/google/google-calendar');
const googleGmail = require('./services/google/google-gmail');
const googleDrive = require('./services/google/google-drive');

app.get('/api/google/auth-url', (req, res) => {
  const url = googleAuth.getAuthUrl();
  if (!url) return res.status(500).json({ ok: false, error: 'Google credentials não configuradas. Adicione GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env ou data/google-credentials.json' });
  res.json({ ok: true, url });
});

app.get('/api/google/callback', async (req, res) => {
  try {
    const tokens = await googleAuth.handleCallback(req.query.code);
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Autenticação concluída!</h1><p>Pode fechar esta aba. O René já tem acesso ao Calendar e Gmail.</p></body></html>');
  } catch (err) {
    res.status(500).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Erro</h1><p>${err.message}</p></body></html>`);
  }
});

app.get('/api/google/status', (req, res) => {
  res.json({ ok: true, authenticated: googleAuth.isAuthenticated(), configured: !!googleAuth.getClient() });
});

// ─── Google Calendar ─────────────────────────────────────────────────────────

app.get('/api/calendar/today', async (req, res) => {
  try {
    const agenda = await googleCalendar.todayAgenda(req.query.calendarId);
    res.json({ ok: true, events: agenda });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/calendar/events', async (req, res) => {
  try {
    const events = await googleCalendar.listEvents(req.query);
    res.json({ ok: true, events });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/calendar/events', express.json(), async (req, res) => {
  try {
    const event = await googleCalendar.createEvent(req.body);
    res.json({ ok: true, event });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/calendar/events/:id', express.json(), async (req, res) => {
  try {
    const event = await googleCalendar.updateEvent(req.params.id, req.body, req.query.calendarId);
    res.json({ ok: true, event });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/calendar/events/:id', async (req, res) => {
  try {
    const result = await googleCalendar.deleteEvent(req.params.id, req.query.calendarId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/calendar/search', async (req, res) => {
  try {
    const events = await googleCalendar.searchEvents(req.query.q, req.query);
    res.json({ ok: true, events });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/calendar/colors', (req, res) => {
  res.json({ ok: true, colors: googleCalendar.COLOR_MAP });
});

// ─── Gmail ───────────────────────────────────────────────────────────────────

app.get('/api/email/inbox', async (req, res) => {
  try {
    const messages = await googleGmail.listMessages({ query: req.query.q, maxResults: parseInt(req.query.max) || 20 });
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/email/unread', async (req, res) => {
  try {
    const count = await googleGmail.unreadCount();
    res.json({ ok: true, ...count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/email/:id', async (req, res) => {
  try {
    const message = await googleGmail.getMessage(req.params.id);
    res.json({ ok: true, message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/email/send', express.json(), async (req, res) => {
  try {
    const result = await googleGmail.sendEmail(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/email/:id/read', async (req, res) => {
  try {
    const result = await googleGmail.markAsRead(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/email/search', async (req, res) => {
  try {
    const messages = await googleGmail.searchEmails(req.query.q, parseInt(req.query.max) || 20);
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Google Drive ────────────────────────────────────────────────────────────

app.post('/api/drive/upload', express.json(), async (req, res) => {
  try {
    const { filePath, folderId, name } = req.body;
    if (!filePath) return res.status(400).json({ ok: false, error: 'filePath é obrigatório' });
    if (!await fs.pathExists(filePath)) return res.status(404).json({ ok: false, error: `Arquivo não encontrado: ${filePath}` });
    const result = await googleDrive.uploadFile(filePath, { folderId, name });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/drive/upload-batch', express.json(), async (req, res) => {
  try {
    const { filePaths, folderId } = req.body;
    if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
      return res.status(400).json({ ok: false, error: 'filePaths (array) é obrigatório' });
    }
    const results = await googleDrive.uploadBatch(filePaths, { folderId });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/drive/folder', express.json(), async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name é obrigatório' });
    const result = await googleDrive.createFolder(name, parentId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/drive/files/:folderId', async (req, res) => {
  try {
    const files = await googleDrive.listFiles(req.params.folderId, parseInt(req.query.limit) || 50);
    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function _sanitizeTask(task) {
  const { _abortController, _timeoutId, ...safe } = task;
  return safe;
}

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