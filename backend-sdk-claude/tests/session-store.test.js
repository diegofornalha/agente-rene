// services/memory/session-store.js — write-through SQLite cache.

const fs = require('fs');
const path = require('path');
const os = require('os');

function freshLoad({ backend = 'sqlite', debounceMs = '10' } = {}) {
  const dbFile = path.join(os.tmpdir(), `hermes-sst-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.SESSION_STORE_BACKEND = backend;
  process.env.SESSION_STORE_DB = dbFile;
  process.env.SESSION_STORE_DEBOUNCE_MS = String(debounceMs);
  delete require.cache[require.resolve('../services/memory/session-store')];
  const mod = require('../services/memory/session-store');
  return { mod, dbFile };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

afterEach(() => {
  for (const f of fs.readdirSync(os.tmpdir()).filter(x => x.startsWith('hermes-sst-'))) {
    try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
  }
});

describe('memory backend (default)', () => {
  test('all operations are no-ops', () => {
    const { mod } = freshLoad({ backend: 'memory' });
    mod.persistMessage({ scope: 'ctx', sessionId: 's1', role: 'user', content: 'hi' });
    const rehydrated = mod.rehydrate({ scope: 'ctx', maxAgeMs: 1000 });
    expect(rehydrated.size).toBe(0);
    expect(mod.stats().backend).toBe('memory');
  });
});

describe('sqlite backend', () => {
  test('persist + rehydrate round-trip', async () => {
    const { mod } = freshLoad();
    mod.persistMessage({ scope: 'ctx', sessionId: 'sess-1', role: 'user', content: 'hello' });
    mod.persistMessage({ scope: 'ctx', sessionId: 'sess-1', role: 'assistant', content: 'world' });
    await sleep(50);
    mod.flushAll();
    const out = mod.rehydrate({ scope: 'ctx', maxAgeMs: 60000 });
    expect(out.size).toBe(1);
    const session = out.get('sess-1');
    expect(session.messages.map(m => m.content)).toEqual(['hello', 'world']);
    expect(session.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  });

  test('multiple atomic messages via persistMessages', async () => {
    const { mod } = freshLoad();
    mod.persistMessages({
      scope: 'wa',
      sessionId: 'jid-1',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    });
    await sleep(50);
    mod.flushAll();
    const out = mod.rehydrate({ scope: 'wa', maxAgeMs: 60000 });
    expect(out.get('jid-1').messages).toHaveLength(2);
  });

  test('maxKeep trims old messages', async () => {
    const { mod } = freshLoad();
    for (let i = 0; i < 10; i++) {
      mod.persistMessage({
        scope: 'ctx', sessionId: 'sess-trim', role: 'user',
        content: `m${i}`, maxKeep: 3,
      });
    }
    await sleep(50);
    mod.flushAll();
    const out = mod.rehydrate({ scope: 'ctx', maxAgeMs: 60000 });
    const msgs = out.get('sess-trim').messages;
    expect(msgs).toHaveLength(3);
    expect(msgs.map(m => m.content)).toEqual(['m7', 'm8', 'm9']);
  });

  test('purge removes session and messages', async () => {
    const { mod } = freshLoad();
    mod.persistMessage({ scope: 'ctx', sessionId: 'doomed', role: 'user', content: 'hi' });
    await sleep(50);
    mod.flushAll();
    expect(mod.rehydrate({ scope: 'ctx', maxAgeMs: 60000 }).size).toBe(1);

    mod.purge({ scope: 'ctx', sessionId: 'doomed' });
    expect(mod.rehydrate({ scope: 'ctx', maxAgeMs: 60000 }).size).toBe(0);
  });

  test('rehydrate respects maxAgeMs window', async () => {
    const { mod } = freshLoad();
    mod.persistMessage({ scope: 'ctx', sessionId: 'recent', role: 'user', content: 'now' });
    await sleep(50);
    mod.flushAll();

    // Just-recent maxAgeMs (1ms) — nothing within window
    await sleep(20);
    expect(mod.rehydrate({ scope: 'ctx', maxAgeMs: 1 }).size).toBe(0);
    // Generous window — included
    expect(mod.rehydrate({ scope: 'ctx', maxAgeMs: 60_000 }).size).toBe(1);
  });

  test('cleanupStale removes old sessions', async () => {
    const { mod } = freshLoad();
    mod.persistMessage({ scope: 'ctx', sessionId: 'aged', role: 'user', content: 'old' });
    await sleep(50);
    mod.flushAll();
    await sleep(20);
    const removed = mod.cleanupStale(10); // anything older than 10ms
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(mod.rehydrate({ scope: 'ctx', maxAgeMs: 60_000 }).size).toBe(0);
  });

  test('stats reports session/message counts per scope', async () => {
    const { mod } = freshLoad();
    mod.persistMessage({ scope: 'ctx', sessionId: 's-ctx', role: 'user', content: 'c1' });
    mod.persistMessage({ scope: 'wa', sessionId: 's-wa', role: 'user', content: 'w1' });
    mod.persistMessage({ scope: 'wa', sessionId: 's-wa', role: 'assistant', content: 'w2' });
    await sleep(50);
    mod.flushAll();
    const s = mod.stats();
    expect(s.backend).toBe('sqlite');
    const ctxRow = s.sessions.find(x => x.scope === 'ctx');
    const waRow = s.sessions.find(x => x.scope === 'wa');
    expect(ctxRow.n).toBe(1);
    expect(waRow.n).toBe(1);
    const ctxMsgs = s.messages.find(x => x.scope === 'ctx');
    const waMsgs = s.messages.find(x => x.scope === 'wa');
    expect(ctxMsgs.n).toBe(1);
    expect(waMsgs.n).toBe(2);
  });
});
