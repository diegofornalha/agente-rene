'use strict';
// routes/health.js — saúde e observabilidade: /api/health, watchdog,
// disk-usage, connection-status, auth-status, health-cron, metrics, hooks.

const { _bearerAuth } = require('../lib/bearer-auth');
const watchdog = require('../services/health/watchdog');
const diskUsage = require('../services/health/disk-usage');
const connStatus = require('../services/health/connection-status');
const healthCron = require('../services/health/health-cron');
const metrics = require('../services/health/metrics');
const hooksService = require('../services/health/hooks');

module.exports = function mount(app, { io, healthChecker }) {

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
  res.json(require('../services/health/auth-monitor').status());
});

app.post('/api/auth-status/probe', async (req, res) => {
  if (!_bearerAuth(req, res)) return;
  const authMonitor = require('../services/health/auth-monitor');
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

};
