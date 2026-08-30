'use strict';
// routes/system.js — llms.txt, openai-compat, leads, upload/export, debug,
// sessions in-memory (CRUD + busca FTS5), skill-curator, MCP e skills hub.

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { _bearerAuth } = require('../lib/bearer-auth');
const llmsIndex = require('../services/skills/llms-index');
const rotaFiscalLeads = require('../services/leads/rota-fiscal-leads');
const sessionsSearch = require('../services/memory/sessions-search');
const mcpClient = require('../services/mcp/mcp-client');
const skillsHub = require('../services/skills/skills-hub-local');
const taskRunner = require('../services/tasks/task-runner');
const { sessions } = require('../services/chat/session-registry');
const { getClaudeResetTime } = require('../services/chat/step-formatter');

module.exports = function mount(app, { upload, sessionContextManager }) {

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
require('../services/openai-compat').mount(app);

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

// FIX na extração (2026-08-30): /api/sessions/search era registrado DEPOIS
// de /api/sessions/:sessionId e ficava sombreado (sempre 404 "Session not
// found"). Registrado ANTES agora — a busca FTS5 volta a ser alcançável.
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
    const curator = require('../services/skills/skill-curator');
    const result = await curator.run(taskRunner);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/curator/reports', (req, res) => {
  const curator = require('../services/skills/skill-curator');
  res.json({ reports: curator.listReports() });
});

app.get('/api/curator/report/:iso', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const { iso } = req.params;
  const REPORT_DIR = path.join(__dirname, '..', 'data', 'curator');
  const f = path.join(REPORT_DIR, `REPORT-${iso}.md`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'report not found' });
  res.setHeader('Content-Type', 'text/markdown');
  res.send(fs.readFileSync(f, 'utf8'));
});

app.get('/api/curator/report', (req, res) => {
  if (!_bearerAuth(req, res)) return;
  try {
    const f = path.join(__dirname, '..', 'data', 'skill-curator-report.json');
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

};
