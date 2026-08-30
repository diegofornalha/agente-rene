// services/health/disk-usage.js — unit tests
const diskUsage = require('../services/health/disk-usage');

describe('disk-usage', () => {
  test('check returns report with expected shape', async () => {
    const report = await diskUsage.check();
    expect(report).toHaveProperty('healthy');
    expect(report).toHaveProperty('totalMB');
    expect(report).toHaveProperty('dirs');
    expect(report).toHaveProperty('alerts');
    expect(report).toHaveProperty('checkedAt');
    expect(typeof report.healthy).toBe('boolean');
    expect(typeof report.totalMB).toBe('number');
    expect(Array.isArray(report.dirs)).toBe(true);
    expect(Array.isArray(report.alerts)).toBe(true);
  });

  test('dirs entries have name, path, sizeMB, status', async () => {
    const report = await diskUsage.check();
    for (const d of report.dirs) {
      expect(d).toHaveProperty('name');
      expect(d).toHaveProperty('path');
      expect(d).toHaveProperty('sizeMB');
      expect(d).toHaveProperty('status');
      expect(typeof d.sizeMB).toBe('number');
      expect(['ok', 'warning', 'critical']).toContain(d.status);
    }
  });

  test('volume info is populated on macOS/Linux', async () => {
    const report = await diskUsage.check();
    if (report.volume) {
      expect(report.volume).toHaveProperty('totalMB');
      expect(report.volume).toHaveProperty('usedMB');
      expect(report.volume).toHaveProperty('availMB');
      expect(report.volume).toHaveProperty('pct');
      expect(report.volume.totalMB).toBeGreaterThan(0);
    }
  });

  test('getDirSizeMB returns 0 for non-existent dir', async () => {
    const size = await diskUsage.getDirSizeMB('/nonexistent/path/12345');
    expect(size).toBe(0);
  });

  test('WATCHED_DIRS is configured', () => {
    expect(diskUsage.WATCHED_DIRS.length).toBeGreaterThan(0);
    for (const w of diskUsage.WATCHED_DIRS) {
      expect(w).toHaveProperty('name');
      expect(w).toHaveProperty('path');
      expect(w).toHaveProperty('warnMB');
      expect(w).toHaveProperty('critMB');
      expect(w.critMB).toBeGreaterThan(w.warnMB);
    }
  });
});
