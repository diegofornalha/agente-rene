// Health Cron — monitor periódico que checa watchdog, disco e conexão WhatsApp,
// e envia alertas via WhatsApp quando algo está fora do normal.
//
// Uso:
//   const healthCron = require('./services/health/health-cron');
//   healthCron.start({ whatsappChannel, watchdog, diskUsage, connStatus });
//   healthCron.stop();
//   healthCron.status();     // → { running, lastCheck, alerts, ... }
//   healthCron.runNow();     // força check imediato
//
// Env vars:
//   HEALTH_CRON_INTERVAL_MIN  — intervalo entre checks (default: 30 min)
//   HEALTH_NOTIFY_JIDS        — JIDs separados por vírgula pra receber alertas
//   HEALTH_DAILY_HOUR         — hora do relatório diário (default: 8 = 08:00)

const os = require('os');

const DEFAULTS = {
  intervalMin: parseInt(process.env.HEALTH_CRON_INTERVAL_MIN || '30', 10),
  dailyHour: parseInt(process.env.HEALTH_DAILY_HOUR || '8', 10),
  notifyJids: (process.env.HEALTH_NOTIFY_JIDS || '').split(',').map(s => s.trim()).filter(Boolean),
};

class HealthCron {
  constructor() {
    this._timer = null;
    this._dailyTimer = null;
    this._deps = {};
    this._lastCheck = null;
    this._lastDaily = null;
    this._alertHistory = [];   // últimos 50 alertas enviados
    this._consecutiveOk = 0;
    this._consecutiveFail = 0;
    this._notifyJids = [];
  }

  start({ whatsappChannel, watchdog, diskUsage, connStatus, logger } = {}) {
    if (this._timer) return;

    this._deps = { whatsappChannel, watchdog, diskUsage, connStatus, logger: logger || console };
    // Ler env no momento do start (não no require) pra testes funcionarem
    this._notifyJids = (process.env.HEALTH_NOTIFY_JIDS || '').split(',').map(s => s.trim()).filter(Boolean);

    if (!this._notifyJids.length) {
      this._deps.logger.warn('[health-cron] Nenhum JID configurado em HEALTH_NOTIFY_JIDS — alertas desativados');
      return;
    }

    if (!whatsappChannel) {
      this._deps.logger.warn('[health-cron] WhatsApp channel não disponível — alertas desativados');
      return;
    }

    const intervalMs = DEFAULTS.intervalMin * 60 * 1000;

    // Check periódico
    this._timer = setInterval(() => this._check(), intervalMs);
    if (this._timer.unref) this._timer.unref();

    // Relatório diário
    this._scheduleDailyReport();

    // Primeiro check após 60s (dar tempo pro WhatsApp conectar)
    this._initialTimer = setTimeout(() => this._check(), 60000);
    if (this._initialTimer.unref) this._initialTimer.unref();

    this._deps.logger.info(`[health-cron] Ativo — check a cada ${DEFAULTS.intervalMin}min, notifica ${this._notifyJids.length} JID(s)`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._dailyTimer) { clearTimeout(this._dailyTimer); this._dailyTimer = null; }
    if (this._initialTimer) { clearTimeout(this._initialTimer); this._initialTimer = null; }
  }

  status() {
    return {
      running: !!this._timer,
      intervalMin: DEFAULTS.intervalMin,
      notifyJids: this._notifyJids,
      lastCheck: this._lastCheck,
      lastDaily: this._lastDaily,
      consecutiveOk: this._consecutiveOk,
      consecutiveFail: this._consecutiveFail,
      recentAlerts: this._alertHistory.slice(-10),
    };
  }

  async runNow() {
    return this._check();
  }

  async _check() {
    const { watchdog, diskUsage, connStatus } = this._deps;
    const problems = [];

    try {
      // 1. Watchdog (event loop, memória)
      if (watchdog) {
        const ws = watchdog.status();
        if (ws.running && !ws.healthy) {
          problems.push(`⚠️ Watchdog: ${ws.recentAlerts?.slice(-1)[0]?.message || 'unhealthy'}`);
        }
        if (ws.lag > 1000) {
          problems.push(`🐌 Event loop lag: ${ws.lag}ms`);
        }
        if (ws.rssPct > 80) {
          problems.push(`🧠 Memória RSS: ${ws.rssPct}%`);
        }
      }

      // 2. Disco
      if (diskUsage) {
        const disk = await diskUsage.check();
        if (!disk.healthy) {
          for (const alert of disk.alerts) {
            problems.push(`💾 ${alert.message}`);
          }
        }
      }

      // 3. Conexão WhatsApp
      if (connStatus) {
        const conn = connStatus.status();
        if (!conn.connected) {
          problems.push(`📱 WhatsApp desconectado (estado: ${conn.state})`);
          if (conn.lastError) {
            problems.push(`   Último erro: ${conn.lastError.message}`);
          }
        }
      }

      // 4. Uptime do processo
      const uptimeH = (process.uptime() / 3600).toFixed(1);

      this._lastCheck = {
        ts: new Date().toISOString(),
        problemCount: problems.length,
        uptimeH,
      };

      if (problems.length > 0) {
        this._consecutiveFail++;
        this._consecutiveOk = 0;
        await this._sendAlert(problems);
      } else {
        this._consecutiveOk++;
        this._consecutiveFail = 0;

        // Notifica recuperação se antes tinha problemas
        if (this._consecutiveOk === 1 && this._alertHistory.length > 0) {
          const lastAlert = this._alertHistory[this._alertHistory.length - 1];
          if (lastAlert && lastAlert.type === 'alert') {
            await this._notify(`✅ Sistema recuperado — todos os checks OK (uptime: ${uptimeH}h)`);
          }
        }
      }
    } catch (err) {
      this._deps.logger.error(`[health-cron] Erro no check: ${err.message}`);
    }
  }

  async _sendAlert(problems) {
    const header = `🚨 *Health Alert* — ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    const body = problems.join('\n');
    const msg = `${header}\n\n${body}\n\n_Check #${this._consecutiveFail} consecutivo com problema_`;

    await this._notify(msg);
    this._alertHistory.push({ type: 'alert', ts: new Date().toISOString(), problems });
    if (this._alertHistory.length > 50) this._alertHistory.shift();
  }

  async _sendDailyReport() {
    const { watchdog, diskUsage, connStatus } = this._deps;
    const lines = [`📊 *Relatório Diário — René Backend*`, `${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, ''];

    // Uptime
    const uptimeH = (process.uptime() / 3600).toFixed(1);
    lines.push(`⏱ Uptime: ${uptimeH}h`);

    // Memória
    const mem = process.memoryUsage();
    lines.push(`🧠 Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`);

    // CPU load
    const load = os.loadavg();
    lines.push(`⚡ Load avg: ${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)}`);

    // Watchdog
    if (watchdog) {
      const ws = watchdog.status();
      const alertCount = ws.recentAlerts?.length || 0;
      lines.push(`🐕 Watchdog: ${ws.healthy !== false ? 'OK' : 'ALERTA'} (${alertCount} alertas recentes)`);
    }

    // Disco
    if (diskUsage) {
      try {
        const disk = await diskUsage.check();
        if (disk.volume) {
          lines.push(`💾 Volume: ${disk.volume.pct}% usado (${disk.volume.availMB}MB livre)`);
        }
        const bigDirs = disk.dirs.filter(d => d.sizeMB > 100).map(d => `  ${d.name}: ${d.sizeMB}MB`);
        if (bigDirs.length) lines.push(...bigDirs);
      } catch {}
    }

    // Conexão WhatsApp
    if (connStatus) {
      const conn = connStatus.status();
      lines.push(`📱 WhatsApp: ${conn.connected ? 'conectado' : 'DESCONECTADO'} (${conn.reconnectCount} reconexões)`);
    }

    // Checks das últimas 24h
    const alertsLast24h = this._alertHistory.filter(a => {
      const age = Date.now() - new Date(a.ts).getTime();
      return age < 24 * 60 * 60 * 1000;
    });
    lines.push(`🔔 Alertas 24h: ${alertsLast24h.length}`);

    const msg = lines.join('\n');
    await this._notify(msg);
    this._lastDaily = new Date().toISOString();
  }

  _scheduleDailyReport() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(DEFAULTS.dailyHour, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    const delay = target.getTime() - now.getTime();
    this._dailyTimer = setTimeout(() => {
      this._sendDailyReport().catch(() => {});
      // Reagendar pro próximo dia
      this._scheduleDailyReport();
    }, delay);
    if (this._dailyTimer.unref) this._dailyTimer.unref();
  }

  async _notify(text) {
    const { whatsappChannel } = this._deps;
    if (!whatsappChannel) return;

    for (const jid of this._notifyJids) {
      try {
        const fullJid = jid.includes('@') ? jid : `${jid}@lid`;
        await whatsappChannel.sendText(fullJid, text);
      } catch (err) {
        this._deps.logger.error(`[health-cron] Falha ao notificar ${jid}: ${err.message}`);
      }
    }
  }
}

// Singleton
const instance = new HealthCron();

module.exports = instance;
module.exports.HealthCron = HealthCron;
