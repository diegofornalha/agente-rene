'use strict';
// routes/google.js — Google OAuth2 + Calendar + Gmail + Drive
// (services/google/*). Callback OAuth é público por natureza.

const express = require('express');
const fs = require('fs-extra');
const { _bearerAuth } = require('../lib/bearer-auth');

module.exports = function mount(app) {

// ─── Google OAuth2 ───────────────────────────────────────────────────────────
const googleAuth = require('../services/google/google-auth');
const googleCalendar = require('../services/google/google-calendar');
const googleGmail = require('../services/google/google-gmail');
const googleDrive = require('../services/google/google-drive');

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

};
