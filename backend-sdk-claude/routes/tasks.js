'use strict';
// routes/tasks.js — rotas de execução: kanban multi-agent, cron jobs,
// automações comerciais e tasks do task-runner.

const express = require('express');
const { _bearerAuth } = require('../lib/bearer-auth');
const kanban = require('../services/tasks/kanban');
const cronScheduler = require('../services/tasks/cron-scheduler');
const taskRunner = require('../services/tasks/task-runner');
const { _sanitizeTask } = require('../services/chat/session-registry');

module.exports = function mount(app) {

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
const briefingRunner = require('../services/automations/briefing-pre-reuniao');
const relatorioRunner = require('../services/automations/relatorio-semanal');

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

};
