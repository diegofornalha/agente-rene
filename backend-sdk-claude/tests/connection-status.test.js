// services/health/connection-status.js — unit tests
const { ConnectionStatus } = require('../services/health/connection-status');

describe('ConnectionStatus', () => {
  let cs;

  beforeEach(() => {
    cs = new ConnectionStatus();
  });

  test('initial status is unknown and not connected', () => {
    const s = cs.status();
    expect(s.state).toBe('unknown');
    expect(s.connected).toBe(false);
    expect(s.reconnectCount).toBe(0);
    expect(s.history).toHaveLength(0);
  });

  test('onConnectionUpdate tracks connecting → open → close lifecycle', () => {
    cs.onConnectionUpdate({ connection: 'connecting' });
    expect(cs.status().state).toBe('connecting');
    expect(cs.status().connected).toBe(false);

    cs.onConnectionUpdate({ connection: 'open' });
    const s = cs.status();
    expect(s.state).toBe('open');
    expect(s.connected).toBe(true);
    expect(s.upSince).toBeDefined();
    expect(s.reconnectCount).toBe(1); // connecting → open counts

    cs.onConnectionUpdate({
      connection: 'close',
      lastDisconnect: { error: { message: 'test error', output: { statusCode: 408 } } },
    });
    const s2 = cs.status();
    expect(s2.state).toBe('close');
    expect(s2.connected).toBe(false);
    expect(s2.lastDisconnect).toBeDefined();
    expect(s2.lastError.message).toBe('test error');
    expect(s2.lastError.code).toBe(408);
  });

  test('reconnectCount increments on each open after close', () => {
    cs.onConnectionUpdate({ connection: 'open' });
    expect(cs.status().reconnectCount).toBe(0); // first open from unknown doesn't count

    cs.onConnectionUpdate({ connection: 'close' });
    cs.onConnectionUpdate({ connection: 'open' });
    expect(cs.status().reconnectCount).toBe(1);

    cs.onConnectionUpdate({ connection: 'close' });
    cs.onConnectionUpdate({ connection: 'open' });
    expect(cs.status().reconnectCount).toBe(2);
  });

  test('history caps at 20 entries', () => {
    for (let i = 0; i < 30; i++) {
      cs.onConnectionUpdate({ connection: i % 2 === 0 ? 'open' : 'close' });
    }
    // Internal history = 20, but status() returns last 10
    const s = cs.status();
    expect(s.history.length).toBeLessThanOrEqual(10);
  });

  test('forceReconnect fails without registered channel', async () => {
    const result = await cs.forceReconnect();
    expect(result.success).toBe(false);
    expect(result.error).toContain('No WhatsApp channel');
  });

  test('forceReconnect calls sock.end when channel is registered', async () => {
    const mockSock = { end: jest.fn() };
    cs.register({ sock: mockSock });
    const result = await cs.forceReconnect();
    expect(result.success).toBe(true);
    expect(mockSock.end).toHaveBeenCalled();
  });

  test('status includes uptimeSeconds when connected', () => {
    cs.onConnectionUpdate({ connection: 'open' });
    const s = cs.status();
    expect(typeof s.uptimeSeconds).toBe('number');
    expect(s.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  test('lastError clears on successful reconnect', () => {
    cs.onConnectionUpdate({
      connection: 'close',
      lastDisconnect: { error: { message: 'boom' } },
    });
    expect(cs.status().lastError).toBeDefined();

    cs.onConnectionUpdate({ connection: 'open' });
    expect(cs.status().lastError).toBeNull();
  });
});
