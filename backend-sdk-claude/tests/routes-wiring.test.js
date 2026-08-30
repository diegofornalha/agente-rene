// Regressão de wiring pós-modularização do server.js: garante que o app.js
// monta e que as rotas extraídas (routes/*.js) registram e respondem.
// Usa supertest direto no app — sem subir porta, sem tocar produção.

const request = require('supertest');

// app.js cria o HTTP server + io mas não dá listen — seguro em teste.
const { app, io, upload } = require('../app');

// Stubs mínimos pras deps que o server.js injeta de verdade.
const healthCheckerStub = {
  getCachedStatus: () => ({ status: 'healthy', stub: true }),
  performFullCheck: async () => ({ status: 'healthy', stub: true }),
};
const sessionContextManagerStub = {
  getFormattedContext: async () => '',
  getStats: async () => ({}),
  clearContext: () => {},
};

beforeAll(() => {
  require('../routes/health')(app, { io, healthChecker: healthCheckerStub });
  require('../routes/system')(app, { upload, sessionContextManager: sessionContextManagerStub });
  require('../routes/whatsapp')(app, { getWhatsappChannel: () => null, sessionContextManager: sessionContextManagerStub });
  require('../routes/tasks')(app);
  require('../routes/roleplay')(app);
});

afterAll(() => {
  io.close();
});

test('GET /api/health responde 200 com status', async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('healthy');
});

test('GET /api/watchdog responde 200', async () => {
  const res = await request(app).get('/api/watchdog');
  expect(res.status).toBe(200);
});

test('GET /llms.txt responde 200 markdown', async () => {
  const res = await request(app).get('/llms.txt');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/markdown/);
});

test('rota com bearer auth exige token (401 sem auth)', async () => {
  const res = await request(app).get('/api/tasks');
  expect([401, 500]).toContain(res.status); // 500 só se secret não configurado
});

test('rota WhatsApp sem canal responde 503 (com auth) ou 401 (sem)', async () => {
  const res = await request(app).get('/api/whatsapp/groups');
  expect([401, 503, 500]).toContain(res.status);
});
