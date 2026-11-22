import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { HttpServer } from '../../src/adapters/transport/HttpServer.js';
import { SqliteStateStore } from '../../src/adapters/persistence/SqliteStateStore.js';
import { PaperBrokerAdapter } from '../../src/adapters/broker/PaperBrokerAdapter.js';
import { RatchetLadderEngine } from '../../src/domain/engines/RatchetLadderEngine.js';
import { RiskGuard } from '../../src/domain/engines/RiskGuard.js';
import { OrderManager } from '../../src/application/OrderManager.js';
import { SessionService } from '../../src/application/SessionService.js';
import { ReconcilerService } from '../../src/application/ReconcilerService.js';
import type { MarketFeedPort } from '../../src/domain/ports/MarketFeedPort.js';

describe('HttpServer Transport Layer Integration', () => {
  const JWT_SECRET = 'TEST_JWT_SECRET_KEY_123456';
  let server: HttpServer;
  let stateStore: SqliteStateStore;
  let broker: PaperBrokerAdapter;
  let engine: RatchetLadderEngine;
  let orderManager: OrderManager;
  let sessionService: SessionService;
  let reconciler: ReconcilerService;
  let validToken: string;
  let baseUrl: string;

  beforeEach(async () => {
    stateStore = new SqliteStateStore(':memory:');
    broker = new PaperBrokerAdapter();
    engine = new RatchetLadderEngine(broker, stateStore);

    const riskGuard = new RiskGuard({
      lotSize: 25,
      maxLotsPerOrder: 4,
      maxOpenQtyPerSymbol: 200,
      maxDailyLossPaise: 500000,
    });

    const feed: MarketFeedPort = {
      subscribe: async () => {},
      unsubscribe: async () => {},
      onTick: () => {},
    };

    orderManager = new OrderManager(broker, feed, engine, riskGuard, stateStore);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionService = new SessionService(broker as any, stateStore, 'API_KEY');
    reconciler = new ReconcilerService(broker, feed, engine, stateStore);

    stateStore.authorizeDevice('DEVICE_123', 'Test Device');

    server = new HttpServer(
      {
        jwtSecret: JWT_SECRET,
        brokerMode: 'paper',
        tradingEnabled: true,
      },
      sessionService,
      orderManager,
      reconciler,
      engine,
      stateStore,
      broker
    );

    baseUrl = await server.listen(0, '127.0.0.1');
    validToken = jwt.sign({ sub: 'trader1', deviceId: 'DEVICE_123' }, JWT_SECRET, { algorithm: 'HS256' });
  });

  afterEach(async () => {
    await server.close();
    stateStore.close();
  });

  it('GET /health returns 200 OK without authentication', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    expect(data.status).toBe('ok');
    expect(data.brokerMode).toBe('paper');
    expect(data.openPositionsCount).toBe(0);
  });

  it('GET /api/auth/login-url rejects request missing X-Device-Id or Authorization header', async () => {
    // Missing X-Device-Id
    const res1 = await fetch(`${baseUrl}/api/auth/login-url`, {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    expect(res1.status).toBe(400);

    // Missing Authorization
    const res2 = await fetch(`${baseUrl}/api/auth/login-url`, {
      headers: { 'X-Device-Id': 'DEVICE_123' },
    });
    expect(res2.status).toBe(401);

    // Invalid Token
    const res3 = await fetch(`${baseUrl}/api/auth/login-url`, {
      headers: {
        'X-Device-Id': 'DEVICE_123',
        Authorization: 'Bearer INVALID_TOKEN',
      },
    });
    expect(res3.status).toBe(401);
  });

  it('GET /api/auth/login-url succeeds with valid JWT and X-Device-Id', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login-url`, {
      headers: {
        'X-Device-Id': 'DEVICE_123',
        Authorization: `Bearer ${validToken}`,
      },
    });

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    expect(data.loginUrl).toContain('https://auth.flattrade.in/?app_key=API_KEY');
  });

  it('POST /api/orders/one-click places entry and creates active ladder', async () => {
    const res = await fetch(`${baseUrl}/api/orders/one-click`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'DEVICE_123',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({
        commandId: '550e8400-e29b-41d4-a716-446655440000',
        token: '26000',
        tradingSymbol: 'NIFTY26NOV24500CE',
        exchange: 'NFO',
        side: 'BUY',
        lots: 2,
        lotSize: 25,
        product: 'I',
        ladderConfig: {
          stepSizePaise: 500,
          breakoutBufferPaise: 100,
          slippageBufferPaise: 150,
        },
      }),
    });

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pos = (await res.json()) as any;
    expect(pos.token).toBe('26000');
    expect(pos.quantity).toBe(50);
    expect(pos.status).toBe('OPEN');
    expect(engine.getPosition('26000')).toBeDefined();
  });

  it('PATCH /api/ladders/:token live-edits ladder milestone & buffers', async () => {
    // Setup position
    await fetch(`${baseUrl}/api/orders/one-click`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'DEVICE_123',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({
        commandId: '550e8400-e29b-41d4-a716-446655440001',
        token: '26000',
        tradingSymbol: 'NIFTY26NOV24500CE',
        exchange: 'NFO',
        side: 'BUY',
        lots: 1,
        lotSize: 25,
        product: 'I',
      }),
    });

    const res = await fetch(`${baseUrl}/api/ladders/26000`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'DEVICE_123',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({
        nextMilestonePaise: 11500,
        stepSizePaise: 600,
        paused: true,
      }),
    });

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = (await res.json()) as any;
    expect(updated.nextMilestonePaise).toBe(11500);
    expect(updated.stepSizePaise).toBe(600);
    expect(updated.isPaused).toBe(true);
  });

  it('POST /api/orders/exit-all executes panic exit across all positions', async () => {
    await fetch(`${baseUrl}/api/orders/one-click`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'DEVICE_123',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({
        commandId: '550e8400-e29b-41d4-a716-446655440002',
        token: '26000',
        tradingSymbol: 'NIFTY26NOV24500CE',
        exchange: 'NFO',
        side: 'BUY',
        lots: 1,
        lotSize: 25,
        product: 'I',
      }),
    });

    const exitRes = await fetch(`${baseUrl}/api/orders/exit-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'DEVICE_123',
        Authorization: `Bearer ${validToken}`,
      },
      body: JSON.stringify({
        commandId: '550e8400-e29b-41d4-a716-446655440003',
      }),
    });

    expect(exitRes.status).toBe(200);
    expect(engine.getAllPositions().length).toBe(0);
  });

  describe('Flattrade OAuth Callback Endpoints', () => {
    it('GET /api/auth/flattrade/callback rejects request missing request_code and code with 400', async () => {
      const res = await fetch(`${baseUrl}/api/auth/flattrade/callback`);
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      expect(data.error).toBe('Missing request_code parameter in OAuth callback');
    });

    it('GET /api/auth/flattrade/callback rejects empty whitespace request_code with 400', async () => {
      const res = await fetch(`${baseUrl}/api/auth/flattrade/callback?request_code=%20%20`);
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      expect(data.error).toBe('Missing request_code parameter in OAuth callback');
    });

    it('GET /api/auth/flattrade/callback succeeds with request_code, unauthenticated, and redirects 302 to scalper://auth/success', async () => {
      const res = await fetch(`${baseUrl}/api/auth/flattrade/callback?request_code=MOCK_FLATTRADE_CODE_123`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('scalper://auth/success');

      // Verify token persisted in SQLite store for today
      const todaySession = await sessionService.getValidTodaySession();
      expect(todaySession).toBeTruthy();
    });

    it('GET /api/auth/flattrade/callback succeeds with code parameter (fallback)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/flattrade/callback?code=MOCK_LEGACY_CODE_456`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('scalper://auth/success');
    });

    it('GET /auth/flattrade/callback legacy alias route also succeeds with 302 redirect', async () => {
      const res = await fetch(`${baseUrl}/auth/flattrade/callback?request_code=MOCK_ALIAS_CODE_789`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('scalper://auth/success');
    });
  });

  describe('Auth Status & Option Chain Endpoints', () => {
    it('GET /api/auth/status returns current broker session and readiness', async () => {
      const res = await fetch(`${baseUrl}/api/auth/status`, {
        headers: {
          'X-Device-Id': 'DEVICE_123',
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      expect(data.status).toBeDefined();
      expect(data.brokerMode).toBe('paper');
      expect(data.brokerConnected).toBe(true);
      expect(data.wsFeedHealthy).toBe(true);
      expect(data.tradingEnabled).toBe(true);
    });

    it('GET /api/option-chain?symbol=SENSEX returns BFO strikes and valid option chain', async () => {
      const res = await fetch(`${baseUrl}/api/option-chain?symbol=SENSEX&strikes=5`, {
        headers: {
          'X-Device-Id': 'DEVICE_123',
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      expect(data.symbol).toBe('SENSEX');
      expect(data.expiry).toBeDefined();
      expect(Array.isArray(data.strikes)).toBe(true);
      expect(data.strikes.length).toBeGreaterThan(0);

      // Verify BFO token naming and strikes around 80000
      const atmStrike = data.strikes.find((s: any) => s.strikePrice === 80000);
      expect(atmStrike).toBeDefined();
      expect(atmStrike.ceToken).toContain('BFO_SENSEX_80000_CE');
      expect(atmStrike.peToken).toContain('BFO_SENSEX_80000_PE');
    });
  });
});
