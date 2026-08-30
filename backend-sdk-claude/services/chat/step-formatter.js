'use strict';
// step-formatter.js — funções PURAS de formatação de steps do Claude Code SDK
// pro chat Socket.IO: mensagens de progresso, resumos de tool use/result,
// classificação de erros e detecção de limite de uso do plano.

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

module.exports = {
  isClaudeLimitError,
  extractResetTime,
  getClaudeResetTime,
  getStepMessage,
  getToolDescription,
  getStepData,
  generateShortId,
  getInputSummary,
  getExpectedOutput,
  getDetailedToolDescription,
  getContentType,
  extractTextContent,
  getOutputSummary,
  getErrorType,
};
