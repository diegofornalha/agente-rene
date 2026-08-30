// bridge-lucrecia/index.js — entrypoint da bridge.
//
// ⚠️ DORMENTE neste deploy: services/bridge-loader.js não existe no backend
// atual, então NADA daqui é carregado no boot. Mantido como referência
// (origem: host lucrecia). Único pedaço ainda citado por tooling vivo é
// hermes-plugins/wagner-wa-groups/ (skill criar-grupo), que roda
// dentro do OpenClaw no host lucrecia — não neste servidor.
//
// Se reativado: carregado por backend-sdk-claude/services/bridge-loader.js no boot.
// Registra todos os endpoints e crons cliente-específicos via ctx.
//
// Convenção de auth:
//   _crmAuth (legado) aceitava WEBHOOK_CRM_SECRET OU WEBHOOK_READAI_SECRET (fallback).
//   Mantemos: bearerEnv: ['WEBHOOK_CRM_SECRET', 'WEBHOOK_READAI_SECRET'].

const CRM_AUTH = { bearerEnv: ['WEBHOOK_CRM_SECRET', 'WEBHOOK_READAI_SECRET'] };

async function init(ctx) {
  const { logger, claudeQuery } = ctx;
  const { query } = claudeQuery; // ctx.claudeQuery = { query, isThrottled }

  // ─── 1. Crons (registry com ~450 jobs gerados) ────────────────────
  ctx.registerCronRegistry(require('./services/crm/crons'));

  // ─── 2. Read.ai webhook (auth HÍBRIDA: ?token= OU Bearer) ─────────
  // O painel de Webhooks (Premium) do Read.ai NÃO oferece campo de header
  // customizado — só dá pra colar a URL. Por isso o canal primário é
  // `?token=<WEBHOOK_READAI_QUERY_TOKEN>` na própria URL (mesmo padrão de
  // /api/tabula/executar). Usamos um token DEDICADO (não o WEBHOOK_READAI_SECRET,
  // que é fallback do CRM_AUTH e abre os endpoints de CRM) pra não vazar acesso
  // de CRM na config de um SaaS externo. O Bearer continua aceito (retrocompat
  // com quem já chama com header). registerHttpHandler (não registerWebhook)
  // porque precisamos do guard customizado de auth.
  const { processReadAi } = require('./services/readai-handler');
  ctx.registerHttpHandler('post', '/api/webhooks/readai', async (req, res) => {
    const crypto = require('crypto');
    const queryTok = process.env.WEBHOOK_READAI_QUERY_TOKEN || '';
    const bearerSecret = process.env.WEBHOOK_READAI_SECRET || '';
    if (!queryTok && !bearerSecret) {
      logger.error('[webhook /api/webhooks/readai]: nem WEBHOOK_READAI_QUERY_TOKEN nem WEBHOOK_READAI_SECRET configurado');
      return res.status(500).json({ ok: false, error: 'server misconfigured: token ausente' });
    }
    const safeEq = (a, b) => {
      if (!a || !b) return false;
      const ba = Buffer.from(a), bb = Buffer.from(b);
      return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
    };
    const presentedQuery = String((req.query && req.query.token) || '');
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const presentedBearer = m ? m[1] : '';
    if (!safeEq(presentedQuery, queryTok) && !safeEq(presentedBearer, bearerSecret)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const startedAt = Date.now();
    try {
      const body = req.body || {};
      const skipClaude = req.query.skipClaude === '1' || req.query.skipClaude === 'true';
      const destOverride = req.query.destinations
        ? String(req.query.destinations).split(',').map(s => s.trim()).filter(Boolean)
        : null;

      let runClaude = null;
      if (!skipClaude) {
        const { collectClaudeResponse } = require('./claude-collect');
        runClaude = async (prompt) => collectClaudeResponse(query({ prompt, options: { maxTurns: 1 } }));
      }
      const result = await processReadAi(body, { runClaude, destinations: destOverride });
      const ms = Date.now() - startedAt;
      if (result.skipped) {
        logger.info(`📭 readai webhook skipped (${ms}ms): ${result.reason}`);
        return res.json({ ok: true, ...result, durationMs: ms });
      }
      const destSummary = Object.entries(result.destinations || {})
        .map(([n, r]) => `${n}=${r.ok ? 'ok' : 'fail'}`).join(' ');
      logger.info(`📬 readai webhook ok (${ms}ms): ${result.meta.nomeArquivoMd} (${result.bytes}B, enriched=${result.enriched}) [${destSummary}]`);
      return res.json({ ok: true, ...result, durationMs: ms });
    } catch (err) {
      logger.error('[webhook /api/webhooks/readai]', err && (err.stack || err.message));
      if (res.headersSent) return;
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── 3. CRM handlers (15 endpoints com .handle()) ─────────────────
  const crmHandlers = [
    ['post', '/api/crm/deal/move-stage',          require('./services/crm/handlers/deal-move-stage')],
    ['post', '/api/crm/deal/promote',             require('./services/crm/handlers/deal-promote')],
    ['post', '/api/crm/lead/criar',               require('./services/crm/handlers/lead-create')],
    ['post', '/api/crm/lead/promote',             require('./services/crm/handlers/lead-promote')],
    ['post', '/api/crm/leads/import-batch',       require('./services/crm/handlers/leads-import-batch')],
    ['post', '/api/crm/invoice/generate',         require('./services/crm/handlers/invoice-generate')],
    ['post', '/api/crm/partner/commission',       require('./services/crm/handlers/partner-commission')],
    ['post', '/api/crm/financial/monthly-report', require('./services/crm/handlers/financial-monthly-report')],
    ['get',  '/api/crm/partners/dashboard',       require('./services/crm/handlers/partners-dashboard')],
    ['post', '/api/crm/partners/dashboard',       require('./services/crm/handlers/partners-dashboard')],
  ];
  for (const [method, route, mod] of crmHandlers) {
    ctx.registerWebhook(route, async (body) => mod.handle(body), { ...CRM_AUTH, method });
  }

  // ─── 3b. Forms entrada cliente novo (Plan Gap C, 2026-05-16) ──────
  // Auth dedicada: WEBHOOK_FORMS_SECRET (não CRM/READAI). Apps Script no
  // Form usa este secret. Plan: ~/.claude/plans/forms-entrada-cliente.md.
  ctx.registerWebhook('/api/forms/cliente-novo-submit',
    async (body) => require('./services/forms/cliente-novo-handler').handle(body),
    { bearerEnv: ['WEBHOOK_FORMS_SECRET'], method: 'post' });

  // ─── 3c. Tábula — executar 1 execução por CNPJ (MVP Diego passo 1+2) ──
  // Endpoint: POST /api/tabula/executar?token=<TABULA_EXEC_TOKEN>
  // Body: { cnpj: '30444414000170', certificadoSlug: 'lsantos-sia' }
  // Auth: token na query (não bearer — facilita cron/curl manual).
  // Roda services/tabula/orquestrador → state machine + persistência JSON
  // por execução em data/tabula-execucoes/ + report Twenty (TODO) + sendText
  // grupo CRM operacional. SMOKE_MODE=1 no env pula sendText real.
  //
  // Por que não bearer header como outros? Tábula vai ser chamada por curl
  // manual + futuros triggers cron/forms — token na query simplifica.
  // Mesma estratégia do roadmap-webhook (registerHttpHandler + token query).
  ctx.registerHttpHandler('post', '/api/tabula/executar', async (req, res) => {
    const crypto = require('crypto');
    const expected = process.env.TABULA_EXEC_TOKEN;
    if (!expected) return res.status(500).json({ ok: false, error: 'TABULA_EXEC_TOKEN ausente' });
    const presented = String((req.query && req.query.token) || '');
    const a = Buffer.from(presented), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const body = req.body || {};
      if (!body.cnpj) return res.status(400).json({ ok: false, error: 'body.cnpj obrigatório' });
      const { executarTabulaCnpj } = require('./services/tabula/orquestrador');
      const result = await executarTabulaCnpj({
        cnpj: body.cnpj,
        certificadoSlug: body.certificadoSlug || 'lsantos-sia',
        opts: { logger },
      });
      const status = result.ok ? 200 : (result.codigo === 'CONFIG_MISSING' ? 500 : 200);
      logger.info(`[tabula/executar] ${result.execId || '?'} → ${result.estado_final || result.codigo} (${result.duracao_ms || 0}ms)`);
      res.status(status).json(result);
    } catch (err) {
      logger.error('[webhook /api/tabula/executar]', err && (err.stack || err.message));
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── 3d. Tábula dashboard data + snapshotter periódico ────────────
  // Endpoint: GET /api/tabula/dashboard-data?token=<TABULA_EXEC_TOKEN>
  // Resposta JSON: { generatedAt, total, counts{done,in_progress,pending,blocked},
  //                  items[{id,name,status,prio,onda,updatedAt}] }
  // O snapshot é gravado também em data/tabula-dashboard.log (JSONL — 1 linha por
  // snapshot) pro Grafana ler via Loki (Promtail já scrapa data/*.log).
  // Painéis do dashboard "Tábula Live" puxam de lá com `| json` parser.
  // Token reutiliza TABULA_EXEC_TOKEN (mesmo guard do executar).
  ctx.registerHttpHandler('get', '/api/tabula/dashboard-data', async (req, res) => {
    const crypto = require('crypto');
    const expected = process.env.TABULA_EXEC_TOKEN;
    if (!expected) return res.status(500).json({ ok: false, error: 'TABULA_EXEC_TOKEN ausente' });
    const presented = String((req.query && req.query.token) || '');
    const a = Buffer.from(presented), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const { getDashboardData } = require('./services/tabula/dashboard-data');
      const snap = await getDashboardData({ logger });
      res.status(200).json({ ok: true, ...snap });
    } catch (err) {
      logger.error('[webhook /api/tabula/dashboard-data]', err && (err.stack || err.message));
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Snapshotter periódico (60s default) — mantém log do dashboard fresco mesmo
  // sem chamadas externas ao endpoint. Idempotente (chamadas duplicadas no-op).
  try {
    require('./services/tabula/dashboard-data').startPeriodicSnapshot({ logger });
    logger.info('[tabula/dashboard] snapshotter periódico iniciado');
  } catch (err) {
    logger.warn && logger.warn('[tabula/dashboard] falha ao iniciar snapshotter:', err.message);
  }

  // ─── 3b. Roteador de tarefas Tábula (boca = grupo fila, cérebro = dispatcher)
  // A BOCA (intent @tábula + enfileiramento) já roda no chat-handler — é inócua
  // (só registra o job). O CÉREBRO (loop que conduz bancada→login→download→
  // geração) só liga com TABULA_DISPATCHER_ENABLED=1 (rollout controlado:
  // exige as bancadas VNC de pé — scripts/tabula/tabula-bancadas-up.sh). Plan: cozy-lamport.
  const filaTarefas = require('./services/tabula/fila-tarefas');
  if (process.env.TABULA_DISPATCHER_ENABLED === '1') {
    try {
      const { criarDispatcher } = require('./services/tabula/dispatcher');
      const cdpDriver = require('./services/tabula/cdp-driver');
      const executorGeracao = require('./services/tabula/executor-geracao');
      const { sendText } = require('./services/crm/whatsapp-send');
      const disp = criarDispatcher({ cdpDriver, executorGeracao, sendTextFn: sendText, logger });
      disp.start();
      logger.info('[tabula/dispatcher] roteador de tarefas iniciado');
    } catch (err) {
      logger.warn && logger.warn('[tabula/dispatcher] falha ao iniciar:', err.message);
    }
  } else {
    logger.info('[tabula/dispatcher] desabilitado (TABULA_DISPATCHER_ENABLED!=1) — boca enfileira, cérebro parado');
  }

  // Endpoint de inspeção da fila (mesmo guard TABULA_EXEC_TOKEN).
  ctx.registerHttpHandler('get', '/api/tabula/fila', async (req, res) => {
    const crypto = require('crypto');
    const expected = process.env.TABULA_EXEC_TOKEN;
    if (!expected) return res.status(500).json({ ok: false, error: 'TABULA_EXEC_TOKEN ausente' });
    const presented = String((req.query && req.query.token) || '');
    const a = Buffer.from(presented), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const filtro = req.query && req.query.estado ? { estado: String(req.query.estado) } : {};
      res.status(200).json({ ok: true, tarefas: filaTarefas.listar(filtro) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── 4. CRM operacional / run / content / email / contract ────────
  const crmRunMap = [
    ['/api/crm/operacional/cessoes-mensais',  () => require('./services/crm/automations/monthly-jobs').cessoesMensais],
    ['/api/crm/operacional/checklist-mensal', () => require('./services/crm/automations/monthly-jobs').checklistMensal],
    ['/api/crm/operacional/cruzar-dados',     () => require('./services/crm/automations/monthly-jobs').cruzarDados],
    ['/api/crm/run/daily-digest',             () => require('./services/crm/automations/daily-digest').run],
    ['/api/crm/run/operacional-cruzamento',   () => require('./services/crm/automations/operacional-cruzamento').run],
    ['/api/crm/run/forecast',                 () => require('./services/crm/automations/forecast').run],
    ['/api/crm/content/generate',             () => require('./services/crm/handlers/content-generate').handle],
    ['/api/crm/email/draft',                  () => require('./services/crm/handlers/email-draft').handle],
    ['/api/crm/contract/send',                () => require('./services/crm/handlers/contract-send').handle],
  ];
  for (const [route, getFn] of crmRunMap) {
    ctx.registerWebhook(route, async (body) => (getFn())(body), CRM_AUTH);
  }

  // ─── 5. Read.ai search/meeting/reconcile ──────────────────────────
  const _readaiIndex = require('./services/readai/index-store');
  ctx.registerWebhook('/api/readai/search', async (q) => ({
    ok: true,
    ..._readaiIndex.searchMeetings({
      q: q.q, from: q.from, to: q.to,
      participant: q.participant,
      clienteId: q.cliente_id, leadId: q.lead_id, dealId: q.deal_id,
      limit: q.limit, offset: q.offset,
    }),
  }), { ...CRM_AUTH, method: 'get' });

  ctx.registerHttpHandler('get', '/api/readai/meeting/:id', async (req, res) => {
    // Auth manual (registerWebhook não suporta route params naturalmente — uso registerHttpHandler)
    const expectedList = [process.env.WEBHOOK_CRM_SECRET, process.env.WEBHOOK_READAI_SECRET].filter(Boolean);
    if (!expectedList.length) return res.status(500).json({ ok: false, error: 'WEBHOOK_CRM_SECRET ausente' });
    const auth = req.headers.authorization || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const a = Buffer.from(presented);
    const ok = expectedList.some(exp => {
      const b = Buffer.from(exp);
      return a.length === b.length && require('crypto').timingSafeEqual(a, b);
    });
    if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
    try {
      const meeting = _readaiIndex.getMeetingById(req.params.id);
      if (!meeting) return res.status(404).json({ ok: false, error: 'meeting not found' });
      res.json({ ok: true, meeting });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  ctx.registerWebhook('/api/readai/reconcile',
    async (body) => require('./services/readai/reconcile').run(body), CRM_AUTH);

  // ─── 6. TaxLife scrapers (4 endpoints) ────────────────────────────
  ctx.registerWebhook('/api/scrape/taxlife/login-test',
    async () => require('./services/scrape/taxlife').healthcheck(), CRM_AUTH);
  ctx.registerWebhook('/api/scrape/taxlife/inventario',
    async (body) => require('./services/scrape/taxlife').inventarioRaiz(body), CRM_AUTH);
  ctx.registerWebhook('/api/scrape/taxlife/aprofundar',
    async (body) => require('./services/scrape/taxlife').aprofundarHrefs(body), CRM_AUTH);
  ctx.registerWebhook('/api/scrape/taxlife/sync',
    async (body) => require('./services/scrape/taxlife').sync(body), CRM_AUTH);

  // ─── 7. WhatsApp inbound ──────────────────────────────────────────
  ctx.registerWebhook('/api/whatsapp/inbound',
    async (body) => require('./services/whatsapp-inbound/handler').handle(body), CRM_AUTH);

  // 7b. Conversa geral da Lucrecia (grupo "lucrecia") — Claude via plano CLI,
  // sem grounding NotebookLM. Acionado pelo bridge wuzapi-mythos-bridge quando
  // rodado com MYTHOS_URL=http://127.0.0.1:3456/api/whatsapp/inbound-chat.
  ctx.registerWebhook('/api/whatsapp/inbound-chat',
    async (body) => require('./services/lucrecia-chat/chat-handler').handle(body), CRM_AUTH);

  // ─── 8. Signer webhook (sem _crmAuth — adapter valida HMAC interno) ──
  ctx.registerHttpHandler('post', '/api/webhooks/signer', async (req, res) => {
    try {
      const result = await require('./services/crm/handlers/signer-webhook').handle(req.body || {}, req.headers);
      res.status(result.status || (result.ok ? 200 : 400)).json(result);
    } catch (err) {
      logger.error('[webhook /api/webhooks/signer]', err && (err.stack || err.message));
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── 8d. Twenty → grupo: webhook de mudança no roadmap ────────────
  // Fecha o loop bidirecional do rewire (Fase B, 2.6). Twenty dispara este
  // POST quando um record do objeto `roadmap` muda; o handler notifica o
  // grupo lucrecia. Auth por token na query (?token=) — Twenty webhook não
  // manda Authorization header. Anti-loop via roadmap-sync-guard.
  ctx.registerHttpHandler('post', '/api/twenty/roadmap-webhook', async (req, res) => {
    const crypto = require('crypto');
    const expected = process.env.TWENTY_WEBHOOK_SECRET;
    if (!expected) return res.status(500).json({ ok: false, error: 'TWENTY_WEBHOOK_SECRET ausente' });
    const presented = String((req.query && req.query.token) || '');
    const a = Buffer.from(presented), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const result = await require('./services/crm/roadmap-webhook').handle(req.body || {});
      logger.info('[twenty/roadmap-webhook]', JSON.stringify(result));
      res.status(200).json(result);
    } catch (err) {
      logger.error('[webhook /api/twenty/roadmap-webhook]', err && (err.stack || err.message));
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── 8d-bis. Twenty → mythos: webhook de mudança de etapa da Oportunidade ──
  // Backbone da AUTOMAÇÃO DA JORNADA COMERCIAL via Kanban (pedido Lucas 23/05/2026).
  // Twenty dispara este POST quando uma Oportunidade muda de stage (você arrasta
  // o card de uma coluna pra outra no Kanban "Funil de Vendas"). O handler de
  // jornada decide qual ação disparar (criar Calendar / disparar NDA / criar
  // contrato / etc), mapeando stage → handler de ação.
  // Auth idêntica ao roadmap-webhook (token na query, mesmo TWENTY_WEBHOOK_SECRET).
  ctx.registerHttpHandler('post', '/api/twenty/opportunity-stage-change', async (req, res) => {
    const crypto = require('crypto');
    const expected = process.env.TWENTY_WEBHOOK_SECRET;
    if (!expected) return res.status(500).json({ ok: false, error: 'TWENTY_WEBHOOK_SECRET ausente' });
    const presented = String((req.query && req.query.token) || '');
    const a = Buffer.from(presented), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const result = await require('./services/jornada/opportunity-webhook').handle(req.body || {});
      logger.info('[twenty/opportunity-stage-change]', JSON.stringify(result));
      res.status(200).json(result);
    } catch (err) {
      logger.error('[webhook /api/twenty/opportunity-stage-change]', err && (err.stack || err.message));
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── 8a. Skills runner — dispara skill .md via Claude SDK ──────────
  // Migrado do server.js do motor (Onda 3.2). Auth aceita qualquer um dos
  // 3 envs (mesmo conjunto do _bearerAuth do motor pra compatibilidade).
  ctx.registerWebhook('/api/skills/run',
    async (body) => require('./services/skills/run-skill').handle(body),
    { bearerEnv: ['API_BEARER_SECRET', 'WEBHOOK_CRM_SECRET', 'WEBHOOK_READAI_SECRET'] });

  // ─── 8b. PDF filler — declaração de residência DETRAN ──────────────
  // Migrado do server.js do motor; usa registerHttpHandler porque retorna
  // application/pdf bruto (não JSON). Template em bridge-lucrecia/preencher/
  // (ver README naquela pasta — não versionado).
  //
  // IMPORTANTE: NÃO usar `require('express').json()` como middleware aqui
  // — express é dep do MOTOR (backend-sdk-claude), não da bridge. Carregar
  // 'express' daqui crasha o init() com 'Cannot find module'. O motor já
  // registra express.json() global no server.js (app.use(express.json({...}))),
  // então req.body chega parseado mesmo sem middleware no handler.
  ctx.registerHttpHandler('post', '/api/preencher/declaracao-residencia', async (req, res) => {
    // Auth inline: aceita API_BEARER_SECRET ou os WEBHOOK_* (mesmo conjunto que o motor usa)
    const crypto = require('crypto');
    const expected = process.env.API_BEARER_SECRET
      || process.env.WEBHOOK_CRM_SECRET
      || process.env.WEBHOOK_READAI_SECRET;
    if (!expected) {
      return res.status(500).json({ ok: false, error: 'API_BEARER_SECRET nao configurado' });
    }
    const auth = req.headers.authorization || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const a = Buffer.from(presented), b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });

    try {
      const { fillDeclaracao } = require('./services/pdf-filler/declaracao-residencia');
      const debug = req.query.debug === '1' || req.body?.debug === true;
      const pdfBytes = await fillDeclaracao(req.body || {}, { debug });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="declaracao-residencia-preenchida.pdf"');
      res.send(pdfBytes);
    } catch (err) {
      logger.error('[pdf-filler]', err && (err.stack || err.message));
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── 8e. Grafana Unified Alerting → grupo WhatsApp ─────────────────
  // Webhook receiver pra alertas do stack obs (Grafana+Loki em
  // /home/lucrecia/grafana-loki/). Auth por token na query (Grafana
  // contact point manda como `?token=<GRAFANA_WEBHOOK_SECRET>`).
  // Roteia critical→CRITICOS, demais→OPERACIONAL (override via label
  // `target_group` no rule). Doc da convenção em
  // services/observabilidade/grafana-alert-webhook.js.
  ctx.registerHttpHandler('post', '/api/grafana/alert-webhook', async (req, res) => {
    const crypto = require('crypto');
    const expected = process.env.GRAFANA_WEBHOOK_SECRET;
    if (!expected) return res.status(500).json({ ok: false, error: 'GRAFANA_WEBHOOK_SECRET ausente' });
    const presented = String((req.query && req.query.token) || '');
    const a = Buffer.from(presented), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const result = await require('./services/observabilidade/grafana-alert-webhook').handle(req.body || {}, req.headers, req);
      logger.info('[grafana/alert]', JSON.stringify(result));
      res.status(200).json(result);
    } catch (err) {
      logger.error('[webhook /api/grafana/alert-webhook]', err && (err.stack || err.message));
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── 9. Self-scan de segurança ────────────────────────────────────
  ctx.registerWebhook('/api/security/scan',
    async () => require('./services/security/self-scan').runScan(), CRM_AUTH);

  // ─── 10. Admin: blast-test pra todos os grupos CRM_GROUP_*_JID ─────
  // Dispara 1 mensagem pra cada grupo configurado. Prova que motor → bridge → wuzapi → WhatsApp
  // funciona end-to-end em runtime real (não em script separado). Usado pra smoke test
  // pós-refatoração e qualquer mudança grande no caminho de envio.
  ctx.registerWebhook('/api/admin/whatsapp-blast-test', async (body) => {
    const { sendText } = require('./services/crm/whatsapp-send');
    const groups = Object.keys(process.env)
      .filter(k => /^CRM_GROUP_.*_JID$/.test(k) && process.env[k])
      .map(k => ({ name: k.replace(/^CRM_GROUP_|_JID$/g, ''), jid: process.env[k] }));

    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
    const customMsg = (body && typeof body.message === 'string') ? body.message : null;
    const msg = customMsg || `🧪 *Teste de funcionamento — backend mythos*

Refatoração concluída: motor puro (\`backend-sdk-claude\`) + bridge plugável (\`bridge-lucrecia\`).

✅ Service ativo, ${ctx._internalGetCronJobs ? ctx._internalGetCronJobs().length : '?'} crons registrados.

Disparado via \`POST /api/admin/whatsapp-blast-test\` → \`bridge-lucrecia/services/crm/whatsapp-send.js\` → wuzapi → grupo. Mensagem chegando = ciclo end-to-end OK.

_${ts} BR — pode ignorar._`;

    const results = [];
    for (const g of groups) {
      try {
        const r = await sendText(msg, g.jid, {
          dedupKey: `admin-blast-test-${Date.now()}-${g.name}`,
          contextLog: { source: 'admin-blast-test', group: g.name },
        });
        results.push({ group: g.name, jid: g.jid, ok: !!r.ok, id: r.id || r.messageId || null, detail: r.ok ? null : r });
      } catch (err) {
        results.push({ group: g.name, jid: g.jid, ok: false, error: err.message });
      }
    }
    const ok = results.filter(r => r.ok).length;
    logger.info(`[admin-blast-test] ${ok}/${results.length} grupos OK`);
    return { ok: ok === results.length, total: results.length, success: ok, failed: results.length - ok, results };
  }, CRM_AUTH);

  // ─── 11. Dossiê pós-assinatura (porte da skill dossie-pos-assinatura-opensign) ──
  // Cron a cada 30min em crm/crons.js scaneia + envia. Endpoints aqui são manuais.
  const dossie = require('./services/dossie');
  ctx.registerWebhook('/api/opensign/dossie/pending', async () => {
    const pending = await dossie.listPending();
    return { ok: true, count: pending.length, pending };
  }, { ...CRM_AUTH, method: 'get' });

  ctx.registerWebhook('/api/opensign/dossie/send', async (body) => {
    if (!body || !body.docId) {
      return { ok: false, error: 'body.docId obrigatório' };
    }
    return dossie.sendDossier(body.docId, { dryRun: !!body.dryRun, logger });
  }, CRM_AUTH);

  ctx.registerWebhook('/api/opensign/dossie/run', async (body) => {
    const apply = !!(body && body.apply);
    const notifyOnly = !!(body && body.notifyOnly);
    const autoMode = !!(body && body.autoMode);
    // Default 'recebedor-assinou' (regra Lucro Ativo desde 2026-05-22 — dossiê sai
    // assim que a recebedora assina). 'envelope-completo' fica como opt-in legado.
    const triggerMode = (body && body.triggerMode) === 'envelope-completo'
      ? 'envelope-completo'
      : 'recebedor-assinou';
    if (apply && notifyOnly) {
      return { ok: false, error: 'apply e notifyOnly são mutuamente exclusivos' };
    }
    return dossie.runWatch({ apply, notifyOnly, autoMode, triggerMode, logger });
  }, CRM_AUTH);

  // ─── 12. Faturas — Encaminhamento operacional (Drive → cliente) ──
  // Fluxo Drive-direto: arquivos já estão no Drive, baixa em memória e anexa.
  ctx.registerWebhook('/api/crm/encaminhar-operacional', async (body) => {
    const { processarEncaminhamento } = require('./services/faturas/encaminhar-operacional');
    const temFolder = body && (body.driveFolderId || (Array.isArray(body.driveFolderIds) && body.driveFolderIds.length));
    if (!temFolder || !body.cliente || !body.tipoImposto || !body.competencia || !Array.isArray(body.recipients) || body.recipients.length === 0) {
      return { ok: false, error: 'body obrigatório: { driveFolderId|driveFolderIds[], cliente, tipoImposto, competencia, recipients[] }' };
    }
    return processarEncaminhamento({
      driveFolderId: body.driveFolderId,
      driveFolderIds: body.driveFolderIds,
      cliente: body.cliente,
      tipoImposto: body.tipoImposto,
      mesOperacao: body.mesOperacao,
      competencia: body.competencia,
      impostosQuitados: body.impostosQuitados,
      lancamentos: body.lancamentos || [],
      valorCobranca: body.valorCobranca,
      pctCobranca: body.pctCobranca || 80,
      vencimentosImpostos: body.vencimentosImpostos || [],
      vencimentoGeral: body.vencimentoGeral,
      observacao: body.observacao,
      textoIntroExtra: body.textoIntroExtra,
      recipients: body.recipients,
      ccLucas: body.ccLucas !== false,  // default true
      subjectOverride: body.subjectOverride,
      dryRun: !!body.dryRun,
      logger,
    });
  }, CRM_AUTH);

  // ─── 13. Cadastro de destinatários — sync Sheet CRM → JSON ──────────
  // POST /api/crm/destinatarios/sync — força sync sob demanda (refresh do cache)
  // GET  /api/crm/destinatarios       — lê JSON atual (debug/Postman)
  ctx.registerWebhook('/api/crm/destinatarios/sync', async (body) => {
    const { syncFromSheet } = require('./services/faturas/encaminhar-operacional/lib/sheet-sync');
    return syncFromSheet({ dryRun: !!(body && body.dryRun), logger });
  }, CRM_AUTH);

  ctx.registerWebhook('/api/crm/destinatarios', async () => {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, 'data', 'destinatarios.json');
    if (!fs.existsSync(p)) return { ok: false, error: 'destinatarios.json não existe — rode /api/crm/destinatarios/sync primeiro' };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }, { ...CRM_AUTH, method: 'get' });

  logger.info('[bridge-lucrecia] init complete');
}

module.exports = { init };
