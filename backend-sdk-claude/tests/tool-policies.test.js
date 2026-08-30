// config/tool-policies.js — channel × role matrix and rollout modes.

const path = require('path');

const POLICY_PATH = path.join(__dirname, '..', 'config', 'tool-policies.js');

function freshLoad(envOverrides = {}) {
  // Patch env, then bust the module cache so the new MODE value is read.
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  delete require.cache[require.resolve(POLICY_PATH)];
  return require(POLICY_PATH);
}

describe('classifyChannel', () => {
  test('maps known sources', () => {
    const { classifyChannel } = require('../config/tool-policies');
    expect(classifyChannel('whatsapp')).toBe('whatsapp');
    expect(classifyChannel('wa')).toBe('whatsapp');
    expect(classifyChannel('telegram')).toBe('telegram');
    expect(classifyChannel('tg')).toBe('telegram');
    expect(classifyChannel('web')).toBe('web');
    expect(classifyChannel('socket.io')).toBe('web');
    expect(classifyChannel('cron')).toBe('cron');
    expect(classifyChannel('kanban')).toBe('kanban');
  });

  test('unknown source falls back to api', () => {
    const { classifyChannel } = require('../config/tool-policies');
    expect(classifyChannel('blargh')).toBe('api');
    expect(classifyChannel(undefined)).toBe('api');
    expect(classifyChannel(null)).toBe('api');
  });
});

describe('classifyRole', () => {
  test('explicit isAdmin wins', () => {
    const mod = freshLoad({ WHATSAPP_ADMIN_NUMBERS: '999' });
    expect(mod.classifyRole({ channel: 'whatsapp', senderId: '999', isAdmin: false })).toBe('user');
    expect(mod.classifyRole({ channel: 'whatsapp', senderId: '123', isAdmin: true })).toBe('admin');
  });

  test('whatsapp admin list match', () => {
    const mod = freshLoad({ WHATSAPP_ADMIN_NUMBERS: '5511999990000,5511888888888' });
    expect(mod.classifyRole({ channel: 'whatsapp', senderId: '5511999990000' })).toBe('admin');
    expect(mod.classifyRole({ channel: 'whatsapp', senderId: '+5511999990000' })).toBe('admin'); // plus stripped via normalize
    expect(mod.classifyRole({ channel: 'whatsapp', senderId: '5511000000000' })).toBe('user');
  });

  test('non-whatsapp channels never become admin without explicit flag', () => {
    const mod = freshLoad({ WHATSAPP_ADMIN_NUMBERS: '5511' });
    expect(mod.classifyRole({ channel: 'web', senderId: '5511' })).toBe('user');
    expect(mod.classifyRole({ channel: 'cron' })).toBe('user');
  });
});

describe('resolvePolicy', () => {
  test('whatsapp+user → readonly toolset', () => {
    const mod = freshLoad({ WHATSAPP_ADMIN_NUMBERS: '' });
    const p = mod.resolvePolicy({ source: 'whatsapp', senderId: '5511999' });
    expect(p.role).toBe('user');
    expect(p.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
    expect(p.permissionMode).toBe('bypassPermissions');
  });

  test('whatsapp+admin → unrestricted', () => {
    const mod = freshLoad({ WHATSAPP_ADMIN_NUMBERS: '5511999' });
    const p = mod.resolvePolicy({ source: 'whatsapp', senderId: '5511999' });
    expect(p.role).toBe('admin');
    expect(p.allowedTools).toBeNull();
  });

  test('agent flag forces Task-only override regardless of channel/role', () => {
    const mod = freshLoad({ WHATSAPP_ADMIN_NUMBERS: '5511999' });
    const p = mod.resolvePolicy({ source: 'whatsapp', senderId: '5511999', agent: 'puro-debugger' });
    expect(p.allowedTools).toEqual(['Task']);
  });

  test('web is trusted local UI', () => {
    const mod = freshLoad();
    const p = mod.resolvePolicy({ source: 'web' });
    expect(p.allowedTools).toBeNull();
    expect(p.permissionMode).toBe('bypassPermissions');
  });
});

describe('applyPolicy with rollout modes', () => {
  const start = () => ({ permissionMode: 'bypassPermissions', maxTurns: 5 });

  test('permissive: never overrides legacy options', () => {
    const mod = freshLoad({ TOOL_POLICY_MODE: 'permissive', WHATSAPP_ADMIN_NUMBERS: '' });
    const r = mod.applyPolicy(start(), { source: 'whatsapp', senderId: '5511' });
    expect(r.options.allowedTools).toBeUndefined();
    expect(r.options.permissionMode).toBe('bypassPermissions');
    expect(r.diff.applied).toBe(false);
  });

  test('log: same as permissive for option mutation', () => {
    const mod = freshLoad({ TOOL_POLICY_MODE: 'log', WHATSAPP_ADMIN_NUMBERS: '' });
    const r = mod.applyPolicy(start(), { source: 'whatsapp', senderId: '5511' });
    expect(r.options.allowedTools).toBeUndefined();
    expect(r.diff.applied).toBe(false);
  });

  test('enforce: applies the policy', () => {
    const mod = freshLoad({ TOOL_POLICY_MODE: 'enforce', WHATSAPP_ADMIN_NUMBERS: '' });
    const r = mod.applyPolicy(start(), { source: 'whatsapp', senderId: '5511' });
    expect(r.options.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
    expect(r.diff.applied).toBe(true);
  });

  test('enforce admin: clears allowedTools (unrestricted)', () => {
    const mod = freshLoad({ TOOL_POLICY_MODE: 'enforce', WHATSAPP_ADMIN_NUMBERS: '5511' });
    const r = mod.applyPolicy({ ...start(), allowedTools: ['Read'] }, { source: 'whatsapp', senderId: '5511' });
    expect(r.options.allowedTools).toBeUndefined();
  });

  test('does not mutate the input options object', () => {
    const mod = freshLoad({ TOOL_POLICY_MODE: 'enforce', WHATSAPP_ADMIN_NUMBERS: '' });
    const input = start();
    const before = JSON.stringify(input);
    mod.applyPolicy(input, { source: 'whatsapp', senderId: '5511' });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('logIfDiverged', () => {
  test('emits a single warn in log mode when divergent', () => {
    const mod = freshLoad({ TOOL_POLICY_MODE: 'log', WHATSAPP_ADMIN_NUMBERS: '' });
    const r = mod.applyPolicy({ permissionMode: 'bypassPermissions' }, { source: 'whatsapp', senderId: '5511' });
    const fakeLogger = { warn: jest.fn() };
    mod.logIfDiverged(r.diff, fakeLogger);
    expect(fakeLogger.warn).toHaveBeenCalledTimes(1);
  });

  test('silent when not in log mode', () => {
    const mod = freshLoad({ TOOL_POLICY_MODE: 'enforce', WHATSAPP_ADMIN_NUMBERS: '' });
    const r = mod.applyPolicy({ permissionMode: 'bypassPermissions' }, { source: 'whatsapp', senderId: '5511' });
    const fakeLogger = { warn: jest.fn() };
    mod.logIfDiverged(r.diff, fakeLogger);
    expect(fakeLogger.warn).not.toHaveBeenCalled();
  });
});

describe('_sameArray helper', () => {
  test('matches null both sides', () => {
    const { _sameArray } = require('../config/tool-policies');
    expect(_sameArray(null, null)).toBe(true);
    expect(_sameArray(undefined, undefined)).toBe(true);
    expect(_sameArray(null, undefined)).toBe(true);
  });

  test('rejects null vs array', () => {
    const { _sameArray } = require('../config/tool-policies');
    expect(_sameArray(null, [])).toBe(false);
    expect(_sameArray(['a'], null)).toBe(false);
  });

  test('order-independent', () => {
    const { _sameArray } = require('../config/tool-policies');
    expect(_sameArray(['a', 'b'], ['b', 'a'])).toBe(true);
  });
});
