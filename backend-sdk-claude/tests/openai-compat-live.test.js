'use strict';
// Testa o adaptador OpenAI-compatível com o CLI mockado: modo legado inalterado, streaming ao vivo
// opt-in e retomada de sessão opt-in. Sem spawn real, sem rede.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
process.env.OPENAI_COMPAT_SESSIONS_PATH = path.join(tmp, 'sessions.json');
process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, 'projects');
process.env.CLAUDECODE_CWD = path.join(tmp, 'shim-cwd');
process.env.OPENAI_COMPAT_KEY = 'k';
process.env.CLAUDECODE_RETRIES = '1';

let mockScripted = [];           // fila de roteiros: cada chamada a query() consome um
const mockCalls = [];            // { prompt, options }
jest.mock('../claude-query', () => ({
  query: ({ prompt, options }) => {
    mockCalls.push({ prompt, options });
    const script = mockScripted.shift() || [];
    return (async function* () { for (const m of script) yield m; })();
  },
}));
jest.mock('../services/health/auth-monitor', () => ({
  isDown: () => false, reportAuthFailure: () => {}, isAuthError: (s) => /not logged in/i.test(String(s)),
}));

const sessionMap = require('../services/session-map');
const { mount, _planPrompt } = require('../services/openai-compat');

const init = (sid) => ({ type: 'system', subtype: 'init', session_id: sid });
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (text, usage = { input_tokens: 3, output_tokens: 2 }) => ({ type: 'result', subtype: 'success', is_error: false, result: text, usage });
const errorResult = (msg) => ({ type: 'result', subtype: 'error', is_error: true, error: msg });

function app() { const a = express(); mount(a); return a; }
const auth = { Authorization: 'Bearer k' };
const parseSse = (text) => text.split('\n\n').filter(b => b.startsWith('data:')).map(b => b.slice(5).trim()).map(d => (d === '[DONE]' ? '[DONE]' : JSON.parse(d)));

beforeEach(() => { mockScripted = []; mockCalls.length = 0; sessionMap._reset(); try { fs.unlinkSync(process.env.OPENAI_COMPAT_SESSIONS_PATH); } catch (_) {} });

test('não-stream continua igual: JSON com choices e usage', async () => {
  mockScripted.push([init('s1'), assistant('oi'), result('oi')]);
  const r = await request(app()).post('/v1/chat/completions').set(auth).send({ model: 'claudecode', messages: [{ role: 'user', content: 'oi' }] });
  expect(r.status).toBe(200);
  expect(r.body.choices[0].message.content).toBe('oi');
  expect(r.body.usage.total_tokens).toBe(5);
  expect(r.headers['x-session-resumed']).toBeUndefined();
  expect(mockCalls[0].options.includePartialMessages).toBe(false);
});

test('stream legado (sem cabeçalho) continua: role, um chunk de texto, stop, [DONE]', async () => {
  mockScripted.push([init('s1'), delta('o'), delta('i'), assistant('oi'), result('oi')]);
  const r = await request(app()).post('/v1/chat/completions').set(auth).send({ model: 'claudecode', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  expect(r.status).toBe(200);
  const events = parseSse(r.text);
  expect(events[0].choices[0].delta).toEqual({ role: 'assistant' });
  expect(events[1].choices[0].delta.content).toBe('oi');
  expect(events[2].choices[0].finish_reason).toBe('stop');
  expect(events[3]).toBe('[DONE]');
  expect(mockCalls[0].options.includePartialMessages).toBe(false);
});

test('stream ao vivo (X-Stream-Mode: live): deltas, stop, usage, [DONE]', async () => {
  mockScripted.push([init('s1'), delta('po'), delta('ng'), assistant('pong'), result('pong')]);
  const r = await request(app()).post('/v1/chat/completions').set(auth).set('X-Stream-Mode', 'live').send({ model: 'claudecode', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/text\/event-stream/);
  expect(r.headers['x-session-resumed']).toBe('false');
  const events = parseSse(r.text);
  expect(events[0].choices[0].delta).toEqual({ role: 'assistant' });
  expect(events[1].choices[0].delta.content).toBe('po');
  expect(events[2].choices[0].delta.content).toBe('ng');
  expect(events[3].choices[0].finish_reason).toBe('stop');
  expect(events[4].usage.total_tokens).toBe(5);
  expect(events[5]).toBe('[DONE]');
  expect(mockCalls[0].options.includePartialMessages).toBe(true);
});

test('stream ao vivo: erro antes de qualquer texto vira 503 JSON', async () => {
  mockScripted.push([init('s1'), errorResult('boom')]);
  const r = await request(app()).post('/v1/chat/completions').set(auth).set('X-Stream-Mode', 'live').send({ model: 'claudecode', stream: true, messages: [{ role: 'user', content: 'oi' }] });
  expect(r.status).toBe(503);
  expect(r.body.error.message).toBe('boom');
});

test('retomada: segunda chamada com X-Conversation-Id usa --resume e só as mensagens novas', async () => {
  const dir = sessionMap.projectDir(process.env.CLAUDECODE_CWD);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-00000001.jsonl'), '{}\n');
  mockScripted.push([init('sess-00000001'), assistant('a1'), result('a1')]);
  const r1 = await request(app()).post('/v1/chat/completions').set(auth).set('X-Conversation-Id', 'conv-1').send({ model: 'claudecode', messages: [{ role: 'user', content: 'u1' }] });
  expect(r1.status).toBe(200);
  expect(r1.headers['x-session-resumed']).toBe('false');
  expect(mockCalls[0].options.resume).toBeUndefined();

  mockScripted.push([init('sess-00000001'), assistant('a2'), result('a2')]);
  const r2 = await request(app()).post('/v1/chat/completions').set(auth).set('X-Conversation-Id', 'conv-1').set('X-Conversation-Seen', '2')
    .send({ model: 'claudecode', messages: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }] });
  expect(r2.status).toBe(200);
  expect(r2.headers['x-session-resumed']).toBe('true');
  expect(mockCalls[1].options.resume).toBe('sess-00000001');
  expect(mockCalls[1].prompt).toBe('u2');

  // sessão sumiu → achata tudo e responde false
  fs.unlinkSync(path.join(dir, 'sess-00000001.jsonl'));
  mockScripted.push([init('sess-00000002'), assistant('a3'), result('a3')]);
  const r3 = await request(app()).post('/v1/chat/completions').set(auth).set('X-Conversation-Id', 'conv-1').set('X-Conversation-Seen', '4')
    .send({ model: 'claudecode', messages: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3' }] });
  expect(r3.headers['x-session-resumed']).toBe('false');
  expect(mockCalls[2].options.resume).toBeUndefined();
  expect(mockCalls[2].prompt).toContain('User: u1');
});

test('_planPrompt: sem cabeçalho de conversa achata tudo', () => {
  const p = _planPrompt({ messages: [{ role: 'user', content: 'x' }], convId: null, seenHdr: null, key: null, options: { cwd: '/x' }, sysHash: 'h' });
  expect(p.resume).toBeNull();
  expect(p.prompt).toBe('User: x');
});
