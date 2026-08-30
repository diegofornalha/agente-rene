// Disk Usage Monitor — monitora espaço em disco das pastas críticas do backend.
//
// Uso:
//   const diskUsage = require('./services/health/disk-usage');
//   const report = await diskUsage.check();
//   // → { healthy: true, totalMB: 234, dirs: [...], alerts: [] }

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, '..', '..');

const WATCHED_DIRS = [
  { name: 'logs', path: path.join(ROOT, 'logs'), warnMB: 500, critMB: 1000 },
  { name: 'data', path: path.join(ROOT, 'data'), warnMB: 1000, critMB: 2000 },
  { name: 'uploads', path: path.join(ROOT, 'uploads'), warnMB: 500, critMB: 1000 },
  { name: 'whatsapp-media', path: path.join(ROOT, 'data', 'whatsapp-inbound-media'), warnMB: 2000, critMB: 5000 },
  { name: 'whatsapp-auth', path: path.join(ROOT, 'data', 'whatsapp-auth'), warnMB: 100, critMB: 500 },
];

async function getDirSizeMB(dirPath) {
  try {
    await fsp.access(dirPath);
  } catch {
    return 0;
  }
  try {
    const { stdout } = await execFileAsync('du', ['-sm', dirPath], { timeout: 10000 });
    const match = stdout.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

async function getVolumeFree() {
  try {
    const { stdout } = await execFileAsync('df', ['-m', ROOT], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(/\s+/);
    // df -m output: Filesystem 1M-blocks Used Available Capacity ...
    return {
      totalMB: parseInt(parts[1], 10) || 0,
      usedMB: parseInt(parts[2], 10) || 0,
      availMB: parseInt(parts[3], 10) || 0,
      pct: parseInt((parts[4] || '').replace('%', ''), 10) || 0,
    };
  } catch {
    return null;
  }
}

async function check() {
  const alerts = [];
  const dirs = [];

  const results = await Promise.all(
    WATCHED_DIRS.map(async (w) => {
      const sizeMB = await getDirSizeMB(w.path);
      const entry = { name: w.name, path: w.path, sizeMB };

      if (sizeMB >= w.critMB) {
        entry.status = 'critical';
        alerts.push({ level: 'critical', dir: w.name, sizeMB, threshold: w.critMB, message: `${w.name}: ${sizeMB}MB (>${w.critMB}MB)` });
      } else if (sizeMB >= w.warnMB) {
        entry.status = 'warning';
        alerts.push({ level: 'warning', dir: w.name, sizeMB, threshold: w.warnMB, message: `${w.name}: ${sizeMB}MB (>${w.warnMB}MB)` });
      } else {
        entry.status = 'ok';
      }
      return entry;
    })
  );

  const totalMB = results.reduce((sum, d) => sum + d.sizeMB, 0);
  const volume = await getVolumeFree();

  if (volume && volume.pct >= 90) {
    alerts.push({ level: 'critical', dir: 'volume', sizeMB: volume.usedMB, threshold: 90, message: `Volume ${volume.pct}% usado (${volume.availMB}MB livre)` });
  } else if (volume && volume.pct >= 80) {
    alerts.push({ level: 'warning', dir: 'volume', sizeMB: volume.usedMB, threshold: 80, message: `Volume ${volume.pct}% usado (${volume.availMB}MB livre)` });
  }

  const hasCritical = alerts.some(a => a.level === 'critical');

  return {
    healthy: !hasCritical,
    totalMB,
    volume,
    dirs: results,
    alerts,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { check, getDirSizeMB, getVolumeFree, WATCHED_DIRS };
