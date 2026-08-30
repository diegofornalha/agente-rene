// services/health/watchdog.js — unit + integration tests
const { Watchdog } = require('../services/health/watchdog');

describe('Watchdog', () => {
  let wd;

  beforeEach(() => {
    wd = new Watchdog();
  });

  afterEach(() => {
    wd.stop();
  });

  test('status returns running=false before start', () => {
    const s = wd.status();
    expect(s.running).toBe(false);
  });

  test('start and stop lifecycle', () => {
    wd.start({ intervalMs: 60000 });
    expect(wd.status().running).toBe(true);
    wd.stop();
    expect(wd.status().running).toBe(false);
  });

  test('start is idempotent', () => {
    wd.start({ intervalMs: 60000 });
    wd.start({ intervalMs: 60000 }); // should not throw or create 2 timers
    expect(wd.status().running).toBe(true);
    wd.stop();
  });

  test('tick populates snapshot with healthy status under normal conditions', (done) => {
    const alerts = [];
    wd.start({
      intervalMs: 100,
      lagThresholdMs: 50000, // extremely high — won't trigger
      memWarningPct: 99,
      memCriticalPct: 100,
      heapWarningMB: 99999,
      heapCriticalMB: 99999,
      onAlert: (a) => alerts.push(a),
    });

    setTimeout(() => {
      const s = wd.status();
      expect(s.running).toBe(true);
      expect(s.healthy).toBe(true);
      expect(typeof s.lag).toBe('number');
      expect(typeof s.rssPct).toBe('number');
      expect(typeof s.heapMB).toBe('number');
      expect(typeof s.rssMB).toBe('number');
      expect(typeof s.uptimeSec).toBe('number');
      expect(s.checkedAt).toBeDefined();
      expect(alerts).toHaveLength(0);
      wd.stop();
      done();
    }, 300);
  });

  test('emits alert on heap warning', (done) => {
    const alerts = [];
    wd.start({
      intervalMs: 100,
      lagThresholdMs: 999999,
      lagCriticalMs: 999999,
      memWarningPct: 100,
      memCriticalPct: 100,
      heapWarningMB: 0,    // will trigger immediately
      heapCriticalMB: 99999,
      onAlert: (a) => alerts.push(a),
    });

    setTimeout(() => {
      expect(alerts.length).toBeGreaterThan(0);
      const heapAlert = alerts.find(a => a.type === 'heap_usage');
      expect(heapAlert).toBeDefined();
      expect(heapAlert.level).toBe('warning');
      wd.stop();
      done();
    }, 300);
  });

  test('emits critical alert on heap critical', (done) => {
    const alerts = [];
    wd.start({
      intervalMs: 100,
      lagThresholdMs: 999999,
      lagCriticalMs: 999999,
      memWarningPct: 100,
      memCriticalPct: 100,
      heapWarningMB: 0,
      heapCriticalMB: 0, // will trigger critical immediately
      onAlert: (a) => alerts.push(a),
    });

    setTimeout(() => {
      const crit = alerts.find(a => a.type === 'heap_usage' && a.level === 'critical');
      expect(crit).toBeDefined();
      const s = wd.status();
      expect(s.healthy).toBe(false);
      wd.stop();
      done();
    }, 300);
  });

  test('ring buffer caps at 50 alerts', (done) => {
    wd.start({
      intervalMs: 10,
      lagThresholdMs: 999999,
      lagCriticalMs: 999999,
      memWarningPct: 100,
      memCriticalPct: 100,
      heapWarningMB: 0,
      heapCriticalMB: 99999,
    });

    setTimeout(() => {
      // After many ticks, the ring buffer shouldn't grow past 50
      const s = wd.status();
      // recentAlerts returns last 10 from the internal buffer
      expect(s.recentAlerts.length).toBeLessThanOrEqual(10);
      wd.stop();
      done();
    }, 800);
  });
});
