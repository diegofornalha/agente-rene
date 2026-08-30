const { HealthCron } = require('../services/health/health-cron');

describe('HealthCron', () => {
  let cron;
  let mockChannel;
  let mockWatchdog;
  let mockDiskUsage;
  let mockConnStatus;

  beforeEach(() => {
    cron = new HealthCron();
    mockChannel = {
      sendText: jest.fn().mockResolvedValue(undefined),
    };
    mockWatchdog = {
      status: jest.fn().mockReturnValue({
        running: true, healthy: true, lag: 5, rssPct: 30, heapMB: 200, recentAlerts: [],
      }),
    };
    mockDiskUsage = {
      check: jest.fn().mockResolvedValue({
        healthy: true, totalMB: 100, volume: { pct: 50, availMB: 5000 },
        dirs: [{ name: 'logs', sizeMB: 10, status: 'ok' }], alerts: [],
      }),
    };
    mockConnStatus = {
      status: jest.fn().mockReturnValue({
        state: 'open', connected: true, reconnectCount: 0, lastError: null,
      }),
    };

    // Setar env pra testes
    process.env.HEALTH_NOTIFY_JIDS = '123456@lid';
  });

  afterEach(() => {
    cron.stop();
    delete process.env.HEALTH_NOTIFY_JIDS;
  });

  test('status() retorna running: false antes de start', () => {
    const s = cron.status();
    expect(s.running).toBe(false);
  });

  test('start sem NOTIFY_JIDS não ativa timer', () => {
    process.env.HEALTH_NOTIFY_JIDS = '';
    const cron2 = new HealthCron();
    cron2.start({ whatsappChannel: mockChannel, watchdog: mockWatchdog });
    expect(cron2.status().running).toBe(false);
    cron2.stop();
  });

  test('start sem whatsappChannel não ativa timer', () => {
    const cron2 = new HealthCron();
    cron2.start({ watchdog: mockWatchdog });
    expect(cron2.status().running).toBe(false);
    cron2.stop();
  });

  test('runNow() checa tudo saudável sem enviar alerta', async () => {
    cron.start({
      whatsappChannel: mockChannel, watchdog: mockWatchdog,
      diskUsage: mockDiskUsage, connStatus: mockConnStatus,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    // Espera o start não disparar o timer imediato
    cron.stop();
    // Limpa timers mas mantém deps
    cron._deps = {
      whatsappChannel: mockChannel, watchdog: mockWatchdog,
      diskUsage: mockDiskUsage, connStatus: mockConnStatus,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    cron._notifyJids = ['123456@lid'];

    await cron.runNow();

    expect(mockWatchdog.status).toHaveBeenCalled();
    expect(mockDiskUsage.check).toHaveBeenCalled();
    expect(mockConnStatus.status).toHaveBeenCalled();
    // Tudo OK = não envia alerta
    expect(mockChannel.sendText).not.toHaveBeenCalled();
    expect(cron._lastCheck.problemCount).toBe(0);
  });

  test('runNow() envia alerta quando watchdog unhealthy', async () => {
    mockWatchdog.status.mockReturnValue({
      running: true, healthy: false, lag: 3000, rssPct: 85,
      recentAlerts: [{ message: 'Event loop lag 3000ms' }],
    });

    cron._deps = {
      whatsappChannel: mockChannel, watchdog: mockWatchdog,
      diskUsage: mockDiskUsage, connStatus: mockConnStatus,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    cron._notifyJids = ['123456@lid'];

    await cron.runNow();

    expect(mockChannel.sendText).toHaveBeenCalled();
    const msg = mockChannel.sendText.mock.calls[0][1];
    expect(msg).toContain('Health Alert');
    expect(msg).toContain('Event loop lag');
  });

  test('runNow() envia alerta quando disco critical', async () => {
    mockDiskUsage.check.mockResolvedValue({
      healthy: false, totalMB: 5000,
      volume: { pct: 95, availMB: 200 },
      dirs: [{ name: 'data', sizeMB: 3000, status: 'critical' }],
      alerts: [{ level: 'critical', message: 'data: 3000MB (>2000MB)' }],
    });

    cron._deps = {
      whatsappChannel: mockChannel, watchdog: mockWatchdog,
      diskUsage: mockDiskUsage, connStatus: mockConnStatus,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    cron._notifyJids = ['123456@lid'];

    await cron.runNow();

    expect(mockChannel.sendText).toHaveBeenCalled();
    const msg = mockChannel.sendText.mock.calls[0][1];
    expect(msg).toContain('3000MB');
  });

  test('runNow() envia alerta quando WhatsApp desconectado', async () => {
    mockConnStatus.status.mockReturnValue({
      state: 'close', connected: false, reconnectCount: 3,
      lastError: { message: 'Connection lost' },
    });

    cron._deps = {
      whatsappChannel: mockChannel, watchdog: mockWatchdog,
      diskUsage: mockDiskUsage, connStatus: mockConnStatus,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    cron._notifyJids = ['123456@lid'];

    await cron.runNow();

    expect(mockChannel.sendText).toHaveBeenCalled();
    const msg = mockChannel.sendText.mock.calls[0][1];
    expect(msg).toContain('desconectado');
  });

  test('envia mensagem de recuperação após problema', async () => {
    cron._deps = {
      whatsappChannel: mockChannel, watchdog: mockWatchdog,
      diskUsage: mockDiskUsage, connStatus: mockConnStatus,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    cron._notifyJids = ['123456@lid'];

    // Simula que houve um alerta antes
    cron._alertHistory.push({ type: 'alert', ts: new Date().toISOString(), problems: ['teste'] });
    cron._consecutiveFail = 1;

    await cron.runNow();

    // Tudo OK agora — deve enviar mensagem de recuperação
    expect(mockChannel.sendText).toHaveBeenCalled();
    const msg = mockChannel.sendText.mock.calls[0][1];
    expect(msg).toContain('recuperado');
  });

  test('stop() limpa timers', () => {
    cron.start({
      whatsappChannel: mockChannel, watchdog: mockWatchdog,
      diskUsage: mockDiskUsage, connStatus: mockConnStatus,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    expect(cron.status().running).toBe(true);
    cron.stop();
    expect(cron.status().running).toBe(false);
  });

  test('_notify adiciona @lid se JID não tem @', async () => {
    cron._deps = {
      whatsappChannel: mockChannel,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    cron._notifyJids = ['999888'];

    await cron._notify('teste');

    expect(mockChannel.sendText).toHaveBeenCalledWith('999888@lid', 'teste');
  });

  test('_notify preserva JID que já tem @', async () => {
    cron._deps = {
      whatsappChannel: mockChannel,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    cron._notifyJids = ['5521999@s.whatsapp.net'];

    await cron._notify('teste');

    expect(mockChannel.sendText).toHaveBeenCalledWith('5521999@s.whatsapp.net', 'teste');
  });
});
