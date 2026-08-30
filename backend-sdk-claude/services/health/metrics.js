// Métricas Prometheus-like pro mythos.
//
// blueprint: hermes-agent/agent/metrics.py (se existir) + padrão Prometheus counters/gauges/histograms.
//
// Métricas expostas em /metrics (formato Prometheus text format).
// Também usado pelo dashboard HTML e pelo alerts hook.

const fs = require('fs-extra');
const path = require('path');

const METRICS_FILE = path.join(__dirname, '..', '..', 'data', 'metrics.json');

// ── Counter/Gauge/Histogram em memória ─────────────────────────────────────

const _counters = {};
const _gauges = {};
const _histograms = {}; // name → { buckets: [], sum, count }

function _getMetric(type, name, help = '') {
  if (type === 'counter') {
    if (!_counters[name]) _counters[name] = { value: 0, help };
    return _counters[name];
  }
  if (type === 'gauge') {
    if (!_gauges[name]) _gauges[name] = { value: 0, help };
    return _gauges[name];
  }
  return null;
}

function incCounter(name, delta = 1) {
  const m = _getMetric('counter', name);
  m.value += delta;
  _persist();
}

function setGauge(name, value) {
  const m = _getMetric('gauge', name);
  m.value = value;
  _persist();
}

function observeHistogram(name, value, buckets = [0.01, 0.05, 0.1, 0.5, 1, 5, 10]) {
  if (!_histograms[name]) {
    _histograms[name] = { buckets, counts: buckets.map(() => 0), sum: 0, count: 0 };
  }
  const h = _histograms[name];
  h.sum += value;
  h.count += 1;
  for (let i = 0; i < h.buckets.length; i++) {
    if (value <= h.buckets[i]) h.counts[i]++;
  }
  _persist();
}

// ── Helpers de alta-level ─────────────────────────────────────────────────

function bumpTask() { incCounter('mythos_tasks_total', 1); }
function bumpReview() { incCounter('mythos_review_forks_total', 1); }

function recordTaskDone({ cost, durationMs, status, tags }) {
  bumpTask();
  if (cost != null) {
    incCounter('mythos_task_cost_usd_total', cost);
    observeHistogram('mythos_task_duration_seconds', durationMs / 1000);
    if (cost > 0.50) incCounter('mythos_task_cost_high', 1);
  }
  if (durationMs > 300_000) incCounter('mythos_task_duration_long', 1);
  if (tags?.includes('background-review')) bumpReview();
}

function setWhatsAppConnected(v) { setGauge('mythos_whatsapp_connected', v ? 1 : 0); }
function setTasksActive(n) { setGauge('mythos_tasks_active', n); }

function recordSkillCount(state, delta = 1) {
  incCounter(`mythos_skill_count_state{${state}}`, delta);
}

function recordMemoryChars(file, chars) {
  setGauge(`mythos_memory_chars{file="${file}"}`, chars);
}

// ── Persistência ────────────────────────────────────────────────────────────

function _persist() {
  try {
    fs.writeJsonSync(METRICS_FILE, {
      counters: _counters,
      gauges: _gauges,
      histograms: _histograms,
      updatedAt: Date.now(),
    }, { spaces: 2 });
  } catch (_) {}
}

function load() {
  try {
    const data = fs.readJsonSync(METRICS_FILE);
    if (data.counters) Object.assign(_counters, data.counters);
    if (data.gauges) Object.assign(_gauges, data.gauges);
    if (data.histograms) Object.assign(_histograms, data.histograms);
  } catch (_) {}
}

load();

// ── Export Prometheus format ───────────────────────────────────────────────

function toPrometheusText() {
  const lines = ['# HELP mythos_tasks_total Total tasks processed'];
  lines.push('# TYPE mythos_tasks_total counter');
  const c = _counters['mythos_tasks_total'];
  if (c) lines.push(`mythos_tasks_total ${c.value}`);

  const c2 = _counters['mythos_task_cost_usd_total'];
  lines.push('# HELP mythos_task_cost_usd_total Total task cost in USD');
  lines.push('# TYPE mythos_task_cost_usd_total counter');
  if (c2) lines.push(`mythos_task_cost_usd_total ${c2.value.toFixed(6)}`);

  const c3 = _counters['mythos_review_forks_total'];
  lines.push('# HELP mythos_review_forks_total Total background review forks');
  lines.push('# TYPE mythos_review_forks_total counter');
  if (c3) lines.push(`mythos_review_forks_total ${c3.value}`);

  const g = _gauges['mythos_whatsapp_connected'];
  lines.push('# HELP mythos_whatsapp_connected WhatsApp connection status (1=up)');
  lines.push('# TYPE mythos_whatsapp_connected gauge');
  if (g) lines.push(`mythos_whatsapp_connected ${g.value}`);

  const g2 = _gauges['mythos_tasks_active'];
  lines.push('# HELP mythos_tasks_active Currently active tasks');
  lines.push('# TYPE mythos_tasks_active gauge');
  if (g2) lines.push(`mythos_tasks_active ${g2.value}`);

  // Skill counts
  for (const [name, val] of Object.entries(_counters)) {
    if (name.startsWith('mythos_skill_count_state{')) {
      lines.push(`# HELP ${name} Skill count by state`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${val.value}`);
    }
  }

  return lines.join('\n') + '\n';
}

// JSON summary pra dashboard
function summary() {
  return {
    tasks: _counters['mythos_tasks_total']?.value || 0,
    costUSD: parseFloat((_counters['mythos_task_cost_usd_total']?.value || 0).toFixed(4)),
    reviews: _counters['mythos_review_forks_total']?.value || 0,
    whatsappUp: _gauges['mythos_whatsapp_connected']?.value === 1,
    tasksActive: _gauges['mythos_tasks_active']?.value || 0,
    highCostTasks: _counters['mythos_task_cost_high']?.value || 0,
    longTasks: _counters['mythos_task_duration_long']?.value || 0,
    updatedAt: Date.now(),
  };
}

module.exports = {
  incCounter, setGauge, observeHistogram,
  bumpTask, bumpReview, recordTaskDone,
  setWhatsAppConnected, setTasksActive, recordSkillCount, recordMemoryChars,
  toPrometheusText, summary,
};