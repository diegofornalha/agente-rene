// Health Watchdog — detecta event loop lag, memory pressure, e processo travado.
//
// Uso:
//   const watchdog = require('./services/health/watchdog');
//   watchdog.start({ onAlert: (alert) => logger.warn(alert) });
//   watchdog.stop();
//   watchdog.status(); // → { healthy: true, lag: 2, memPct: 45, ... }
//
// Alertas emitidos via callback `onAlert({ level, type, message, value, threshold })`.
// Não faz restart automático — quem decide o que fazer com o alerta é o chamador.

const os = require('os');

const DEFAULTS = {
  intervalMs: 5000,              // check a cada 5s
  lagThresholdMs: 500,           // event loop lag > 500ms = warning
  lagCriticalMs: 2000,           // event loop lag > 2s = critical
  memWarningPct: 80,             // RSS > 80% do total = warning
  memCriticalPct: 92,            // RSS > 92% = critical
  heapWarningMB: 1400,           // heapUsed > 1.4GB = warning (V8 default ~1.7GB)
  heapCriticalMB: 1600,          // heapUsed > 1.6GB = critical
};

class Watchdog {
  constructor() {
    this._timer = null;
    this._lastTick = null;
    this._opts = { ...DEFAULTS };
    this._onAlert = null;
    this._alerts = [];            // ring buffer das últimas 50 alertas
    this._snapshot = null;        // último snapshot de status
    this._consecutiveLag = 0;     // quantos ticks consecutivos com lag alto
  }

  start(opts = {}) {
    if (this._timer) return;
    Object.assign(this._opts, opts);
    this._onAlert = opts.onAlert || null;
    this._lastTick = Date.now();

    this._timer = setInterval(() => this._tick(), this._opts.intervalMs);
    // Não impedir shutdown do processo
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  status() {
    return {
      running: !!this._timer,
      ...(this._snapshot || {}),
      recentAlerts: this._alerts.slice(-10),
    };
  }

  _tick() {
    const now = Date.now();
    const expected = this._opts.intervalMs;
    const actual = now - (this._lastTick || now);
    const lag = Math.max(0, actual - expected);
    this._lastTick = now;

    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const rssPct = (mem.rss / totalMem) * 100;
    const heapMB = mem.heapUsed / (1024 * 1024);
    const uptime = process.uptime();

    this._snapshot = {
      healthy: true,
      lag,
      rssPct: parseFloat(rssPct.toFixed(1)),
      heapMB: Math.round(heapMB),
      rssMB: Math.round(mem.rss / (1024 * 1024)),
      uptimeSec: Math.round(uptime),
      checkedAt: new Date().toISOString(),
    };

    // Event loop lag
    if (lag > this._opts.lagCriticalMs) {
      this._consecutiveLag++;
      this._emit('critical', 'event_loop_lag', `Event loop lag ${lag}ms (>${this._opts.lagCriticalMs}ms) — consecutivo #${this._consecutiveLag}`, lag, this._opts.lagCriticalMs);
      this._snapshot.healthy = false;
    } else if (lag > this._opts.lagThresholdMs) {
      this._consecutiveLag++;
      this._emit('warning', 'event_loop_lag', `Event loop lag ${lag}ms (>${this._opts.lagThresholdMs}ms)`, lag, this._opts.lagThresholdMs);
    } else {
      this._consecutiveLag = 0;
    }

    // Memory (RSS % do sistema)
    if (rssPct > this._opts.memCriticalPct) {
      this._emit('critical', 'memory_rss', `RSS ${rssPct.toFixed(1)}% do sistema (>${this._opts.memCriticalPct}%)`, rssPct, this._opts.memCriticalPct);
      this._snapshot.healthy = false;
    } else if (rssPct > this._opts.memWarningPct) {
      this._emit('warning', 'memory_rss', `RSS ${rssPct.toFixed(1)}% do sistema (>${this._opts.memWarningPct}%)`, rssPct, this._opts.memWarningPct);
    }

    // Heap (valor absoluto)
    if (heapMB > this._opts.heapCriticalMB) {
      this._emit('critical', 'heap_usage', `Heap ${Math.round(heapMB)}MB (>${this._opts.heapCriticalMB}MB)`, heapMB, this._opts.heapCriticalMB);
      this._snapshot.healthy = false;
    } else if (heapMB > this._opts.heapWarningMB) {
      this._emit('warning', 'heap_usage', `Heap ${Math.round(heapMB)}MB (>${this._opts.heapWarningMB}MB)`, heapMB, this._opts.heapWarningMB);
    }
  }

  _emit(level, type, message, value, threshold) {
    const alert = { level, type, message, value, threshold, ts: new Date().toISOString() };
    this._alerts.push(alert);
    if (this._alerts.length > 50) this._alerts.shift();
    if (this._onAlert) {
      try { this._onAlert(alert); } catch (_) {}
    }
  }
}

// Singleton
const instance = new Watchdog();

module.exports = instance;
module.exports.Watchdog = Watchdog;
