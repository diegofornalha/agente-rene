// claude-query.js — flag assembly, NDJSON parsing, error path, throttle slot.
//
// child_process.spawn is replaced by a jest mock that returns a fake child
// (EventEmitter with stdout/stderr emitters). Tests drive the streams to
// simulate Claude CLI output without spawning anything.

const { EventEmitter } = require('events');

jest.mock('child_process', () => {
  const real = jest.requireActual('child_process');
  return {
    ...real,
    spawn: jest.fn(),
  };
});

// Re-fetched inside beforeEach because jest.resetModules() invalidates the
// previously imported reference and the mock factory recreates jest.fn().
let spawnRef;

function nextChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  spawnRef.mockImplementationOnce((bin, args, opts) => {
    spawnRef._lastCall = { bin, args, opts };
    return child;
  });
  return child;
}

beforeEach(() => {
  jest.resetModules();
  spawnRef = require('child_process').spawn;
  spawnRef.mockReset();
  spawnRef._lastCall = null;
});

describe('query() flag assembly', () => {
  test('builds the expected CLI args from options', async () => {
    const child = nextChild();
    const { query } = require('../claude-query');

    const iter = query({
      prompt: 'do the thing',
      options: {
        maxTurns: 3,
        permissionMode: 'bypassPermissions',
        model: 'claude-opus-4-6',
        appendSystemPrompt: 'be polite',
        allowedTools: ['Read', 'Grep'],
        includePartialMessages: true,
      },
    });

    // Kick the generator so the spawn happens, then close cleanly.
    const collect = (async () => { for await (const _ of iter) {} })();
    setImmediate(() => child.emit('close', 0));
    await collect;

    expect(spawnRef).toHaveBeenCalledTimes(1);
    const args = spawnRef._lastCall.args;
    expect(args[0]).toMatch(/@anthropic-ai\/claude-code\/cli-wrapper\.cjs$/);
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--print');
    expect(args).toContain('--max-turns');
    expect(args).toContain('3');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4-6');
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('be polite');
    const allowedIdx = args.reduce((acc, a, i) => a === '--allowedTools' ? [...acc, i] : acc, []);
    expect(allowedIdx).toHaveLength(2);
    expect(args).toContain('Read');
    expect(args).toContain('Grep');
    expect(args).toContain('--include-partial-messages');
    // O prompt vai por STDIN (fix E2BIG), não como argumento.
    expect(args).not.toContain('do the thing');
  });
});

describe('NDJSON parsing', () => {
  test('yields each line as a parsed object', async () => {
    const child = nextChild();
    const { query } = require('../claude-query');
    const iter = query({ prompt: 'x', options: {} });
    const out = [];
    const collect = (async () => { for await (const m of iter) out.push(m); })();

    await new Promise(setImmediate); // let spawn run
    child.stdout.emit('data', Buffer.from('{"type":"assistant","text":"hi"}\n'));
    child.stdout.emit('data', Buffer.from('{"type":"result","is_error":false}\n'));
    child.emit('close', 0);
    await collect;

    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('assistant');
    expect(out[1].type).toBe('result');
    expect(out[1].is_error).toBe(false);
  });

  test('skips malformed JSON lines silently', async () => {
    const child = nextChild();
    const { query } = require('../claude-query');
    const iter = query({ prompt: 'x', options: {} });
    const out = [];
    const collect = (async () => { for await (const m of iter) out.push(m); })();
    await new Promise(setImmediate);
    child.stdout.emit('data', Buffer.from('{ broken json\n'));
    child.stdout.emit('data', Buffer.from('{"type":"ok"}\n'));
    child.emit('close', 0);
    await collect;
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('ok');
  });

  test('handles split chunks (incomplete line in buffer)', async () => {
    const child = nextChild();
    const { query } = require('../claude-query');
    const iter = query({ prompt: 'x', options: {} });
    const out = [];
    const collect = (async () => { for await (const m of iter) out.push(m); })();
    await new Promise(setImmediate);
    child.stdout.emit('data', Buffer.from('{"type":"part'));
    child.stdout.emit('data', Buffer.from('ial"}\n'));
    child.emit('close', 0);
    await collect;
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('partial');
  });
});

describe('error paths', () => {
  test('non-zero exit yields error result with stderr tail', async () => {
    const child = nextChild();
    const { query } = require('../claude-query');
    const iter = query({ prompt: 'x', options: {} });
    const out = [];
    const collect = (async () => { for await (const m of iter) out.push(m); })();
    await new Promise(setImmediate);
    child.stderr.emit('data', Buffer.from('rate limit exceeded\n'));
    child.emit('close', 1);
    await collect;
    expect(out.length).toBeGreaterThanOrEqual(1);
    const errMsg = out[out.length - 1];
    expect(errMsg.is_error).toBe(true);
    expect(errMsg.error).toContain('exited with code 1');
    expect(errMsg.error).toContain('rate limit exceeded');
  });

  test("spawn 'error' event surfaces as result error", async () => {
    const child = nextChild();
    const { query } = require('../claude-query');
    const iter = query({ prompt: 'x', options: {} });
    const out = [];
    const collect = (async () => { for await (const m of iter) out.push(m); })();
    await new Promise(setImmediate);
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    child.emit('error', err);
    await collect;
    expect(out[0].is_error).toBe(true);
    expect(out[0].error).toContain('spawn failed');
    expect(out[0].error).toContain('ENOENT');
  });
});

describe('throttle introspection', () => {
  test('isThrottled / getActiveProcessCount expose state', () => {
    const { isThrottled, getActiveProcessCount } = require('../claude-query');
    expect(typeof isThrottled()).toBe('boolean');
    expect(typeof getActiveProcessCount()).toBe('number');
  });
});
