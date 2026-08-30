// services/whatsapp/log-rotator.js — date+size rotation, append serialization,
// byte-for-byte format preservation.

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createRotator,
  buildArchivePath,
  utcDateString,
} = require('../services/whatsapp/log-rotator');

function tmp() {
  return path.join(os.tmpdir(), `hermes-logrot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

function cleanup(base) {
  const dir = path.dirname(base);
  const name = path.basename(base, path.extname(base));
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(name)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  }
}

describe('utcDateString', () => {
  test('returns YYYY-MM-DD', () => {
    const d = new Date(Date.UTC(2026, 5, 9, 12, 34, 56));
    expect(utcDateString(d)).toBe('2026-06-09');
  });
});

describe('buildArchivePath', () => {
  test('uses base + date when free', () => {
    const tmpDir = os.tmpdir();
    const base = path.join(tmpDir, 'never-existed.log');
    expect(buildArchivePath(base, '2026-06-09'))
      .toBe(path.join(tmpDir, 'never-existed-2026-06-09.log'));
  });

  test('appends counter on same-day collision', () => {
    const file = tmp() + '.log';
    fs.writeFileSync(file, '');
    const archive1 = buildArchivePath(file, '2026-06-09');
    fs.writeFileSync(archive1, '');
    const archive2 = buildArchivePath(file, '2026-06-09');
    expect(archive2).toContain('2026-06-09-2.log');
    cleanup(file);
  });
});

describe('createRotator — size trigger', () => {
  test('rotates after exceeding maxBytes', async () => {
    const file = tmp() + '.log';
    const events = [];
    const r = createRotator(file, { maxBytes: 50, onRotate: ev => events.push(ev) });
    for (let i = 0; i < 5; i++) await r.write('A'.repeat(20) + '\n');
    await r.drain();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].reason).toBe('size');
    // Active file has the last write(s); archives exist
    const dir = path.dirname(file);
    const archives = fs.readdirSync(dir).filter(f => f.includes(path.basename(file, '.log')) && f.includes('2'));
    expect(archives.length).toBeGreaterThanOrEqual(1);
    cleanup(file);
  });

  test('does not rotate when below threshold', async () => {
    const file = tmp() + '.log';
    const events = [];
    const r = createRotator(file, { maxBytes: 1000, onRotate: ev => events.push(ev) });
    for (let i = 0; i < 3; i++) await r.write('A'.repeat(20) + '\n');
    await r.drain();
    expect(events.length).toBe(0);
    cleanup(file);
  });
});

describe('createRotator — date trigger', () => {
  test('rotates when UTC date changes', async () => {
    const file = tmp() + '.log';
    let day = 1;
    const clock = () => new Date(Date.UTC(2026, 5, day));
    const events = [];
    const r = createRotator(file, { clock, onRotate: ev => events.push(ev) });

    await r.write('linha do dia 1\n');
    day = 2;
    await r.write('linha do dia 2\n');
    day = 3;
    await r.write('linha do dia 3\n');
    await r.drain();

    expect(events.length).toBe(2);
    expect(events[0].fromDate).toBe('2026-06-01');
    expect(events[0].toDate).toBe('2026-06-02');
    expect(events[0].reason).toBe('date');
    cleanup(file);
  });
});

describe('createRotator — byte-for-byte format preservation', () => {
  test('preserves whatsapp-conversas line format exactly', async () => {
    const file = tmp() + '.log';
    const r = createRotator(file);
    const line = `2026-06-09T12:00:00.000Z [+5521999990000]: oi tudo bem\\nsegunda linha\n`;
    await r.write(line);
    await r.drain();
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).toBe(line);
    cleanup(file);
  });

  test('serializes concurrent writes', async () => {
    const file = tmp() + '.log';
    const r = createRotator(file);
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(r.write(`line-${i}\n`));
    }
    await Promise.all(promises);
    await r.drain();
    const onDisk = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(onDisk).toEqual(Array.from({ length: 10 }, (_, i) => `line-${i}`));
    cleanup(file);
  });
});
