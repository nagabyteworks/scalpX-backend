import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { HttpServer } from '../src/adapters/transport/HttpServer.js';
import { SqliteStateStore } from '../src/adapters/persistence/SqliteStateStore.js';
import { MockBrokerAdapter } from './mock/MockBrokerAdapter.js';
import { RatchetLadderEngine } from '../src/domain/engines/RatchetLadderEngine.js';
import { RiskGuard } from '../src/domain/engines/RiskGuard.js';
import { OrderManager } from '../src/application/OrderManager.js';
import { SessionService } from '../src/application/SessionService.js';
import { ReconcilerService } from '../src/application/ReconcilerService.js';
import type { MarketFeedPort } from '../src/domain/ports/MarketFeedPort.js';

describe('TOTP-only Authentication Security', () => {
  const JWT_SECRET = 'TEST_JWT_SECRET_KEY_123456';
  let server: HttpServer;
  let stateStore: SqliteStateStore;
  let broker: MockBrokerAdapter;

  beforeEach(async () => {
    stateStore = new SqliteStateStore(':memory:');
    broker = new MockBrokerAdapter();
    const engine = new RatchetLadderEngine(broker, stateStore);
    const riskGuard = new RiskGuard({ rateLimitCapacity: 6, refillRatePerSec: 6 }, stateStore);
    const feed: MarketFeedPort = { subscribe: async () => {}, unsubscribe: async () => {}, onTick: () => {} };
    const orderManager = new OrderManager(broker, feed, engine, riskGuard, stateStore);
    const sessionService = new SessionService(broker as any, stateStore, 'API_KEY');
    const reconciler = new ReconcilerService(broker, feed, engine, stateStore);
    server = new HttpServer(
      { jwtSecret: JWT_SECRET, deviceTotpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', tradingEnabled: true },
      sessionService, orderManager, reconciler, engine, stateStore, broker
    );
    await server.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await server.close();
    stateStore.close();
  });

  it('issues a short-lived session for valid TOTP and rejects replay', async () => {
    vi.setSystemTime(new Date(59_000));
    const payload = { totp: '287082' };
    const first = await server.app.inject({ method: 'POST', url: '/api/auth/daily-login', payload });
    expect(first.statusCode).toBe(200);
    const issued = JSON.parse(first.payload);
    expect(issued.expiresIn).toBe(900);
    expect((jwt.verify(issued.accessToken, JWT_SECRET) as any).role).toBe('owner');

    const replay = await server.app.inject({ method: 'POST', url: '/api/auth/daily-login', payload });
    expect(replay.statusCode).toBe(401);
    vi.useRealTimers();
  });

  it('rejects malformed TOTP and rate limits repeated failures', async () => {
    const malformed = await server.app.inject({
      method: 'POST',
      url: '/api/auth/daily-login',
      payload: { totp: '12ab56' },
    });
    expect(malformed.statusCode).toBe(400);

    for (let attempt = 0; attempt < 5; attempt++) {
      await server.app.inject({
        method: 'POST',
        url: '/api/auth/daily-login',
        payload: { totp: '000000' },
      });
    }
    const limited = await server.app.inject({
      method: 'POST',
      url: '/api/auth/daily-login',
      payload: { totp: '000000' },
    });
    expect(limited.statusCode).toBe(429);
  });

  it('requires a bearer session for protected APIs', async () => {
    const unauthorized = await server.app.inject({ method: 'GET', url: '/api/trades/today' });
    expect(unauthorized.statusCode).toBe(401);

    const token = jwt.sign({ sub: 'scalpx-owner', role: 'owner' }, JWT_SECRET, { expiresIn: '15m' });
    const authorized = await server.app.inject({
      method: 'GET',
      url: '/api/trades/today',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it('removes legacy provisioning endpoints', async () => {
    const provision = await server.app.inject({ method: 'POST', url: '/api/auth/provision-device', payload: {} });
    const revoke = await server.app.inject({ method: 'POST', url: '/api/auth/revoke-device', payload: {} });
    const oldAuthenticate = await server.app.inject({ method: 'POST', url: '/api/auth/device/authenticate', payload: {} });
    expect(provision.statusCode).toBe(404);
    expect(revoke.statusCode).toBe(404);
    expect(oldAuthenticate.statusCode).toBe(404);
  });

  it('removes legacy authorization data and exposes atomic replay state', async () => {
    expect(await stateStore.consumeTotpStep(100)).toBe(true);
    expect(await stateStore.consumeTotpStep(100)).toBe(false);
    expect(await stateStore.consumeTotpStep(99)).toBe(false);
  });
});
