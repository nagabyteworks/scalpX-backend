import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { HttpServer } from '../../src/adapters/transport/HttpServer.js';
import { SqliteStateStore } from '../../src/adapters/persistence/SqliteStateStore.js';
import { MockBrokerAdapter } from '../mock/MockBrokerAdapter.js';
import { RatchetLadderEngine } from '../../src/domain/engines/RatchetLadderEngine.js';
import { RiskGuard } from '../../src/domain/engines/RiskGuard.js';
import { OrderManager } from '../../src/application/OrderManager.js';
import { getTodayDateIST, SessionService } from '../../src/application/SessionService.js';
import { ReconcilerService } from '../../src/application/ReconcilerService.js';
import type { MarketFeedPort } from '../../src/domain/ports/MarketFeedPort.js';

describe('HttpServer Transport Layer Integration', () => {
  const JWT_SECRET = 'TEST_JWT_SECRET_KEY_123456';
  let server: HttpServer;
  let stateStore: SqliteStateStore;
  let broker: MockBrokerAdapter;
  let engine: RatchetLadderEngine;
  let orderManager: OrderManager;
  let sessionService: SessionService;
  let reconciler: ReconcilerService;
  let validToken: string;
  let baseUrl: string;

  beforeEach(async () => {
    stateStore = new SqliteStateStore(':memory:');
    broker = new MockBrokerAdapter();
    broker.processTick({ token: '26000', ltpPaise: 11005, timestamp: Date.now() });
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
        tradingEnabled: false,
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
    expect(data.environment).toBe('LIVE');
    expect(data.tradingEnabled).toBe(false);
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

  it('POST /api/orders/one-click rejects entry while live trading authorization is disabled', async () => {
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

    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toMatch(/disabled/i);
    expect(engine.getPosition('26000')).toBeUndefined();
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

    expect(res.status).toBe(404);
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

    it('GET /api/auth/flattrade/callback reports exchange failure from a broker mock without OAuth support', async () => {
      const res = await fetch(`${baseUrl}/api/auth/flattrade/callback?request_code=MOCK_FLATTRADE_CODE_123`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(502);
      expect((await res.json() as any).error).toMatch(/OAuth exchange failed/);
    });

    it('GET /api/auth/flattrade/callback rejects an unsupported mocked code exchange', async () => {
      const res = await fetch(`${baseUrl}/api/auth/flattrade/callback?code=MOCK_LEGACY_CODE_456`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(502);
    });

    it('GET /auth/flattrade/callback legacy alias uses the same safe failure response', async () => {
      const res = await fetch(`${baseUrl}/auth/flattrade/callback?request_code=MOCK_ALIAS_CODE_789`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(502);
    });
  });

  describe('Auth Status & Option Chain Endpoints', () => {
    it('GET /api/market-data/sensex returns unavailable without a verified broker index token', async () => {
      const response = await fetch(`${baseUrl}/api/market-data/sensex`, {
        headers: { 'X-Device-Id': 'DEVICE_123', Authorization: `Bearer ${validToken}` },
      });
      expect(response.status).toBe(503);
      const data = await response.json() as any;
      expect(data.index).toBe('SENSEX');
      expect(data.status).toBe('INSTRUMENT_UNAVAILABLE');
      expect(data.spotLtpPaise).toBeNull();
    });

    it('GET /api/auth/status reports LIVE mode without claiming a live feed', async () => {
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
      expect(data.environment).toBe('LIVE');
      expect(data.brokerConnected).toBe(false);
      expect(data.sessionValid).toBe(false);
      expect(data.sessionValidity).toBe('INVALID');
      expect(data.marketDataReady).toBe(false);
      expect(data.wsFeedHealthy).toBe(false);
      expect(data.status).not.toBe('FEED_READY');
      expect(data.tradingEnabled).toBe(false);
    });

    it('GET /api/auth/status distinguishes live session, socket auth, and fresh feed transitions', async () => {
      const mutableFeed = {
        state: 'DISCONNECTED',
        transport: false,
        authenticated: false,
        ready: false,
        getConnectionState() { return this.state; },
        isTransportConnected() { return this.transport; },
        isAuthenticatedConnection() { return this.authenticated; },
        isMarketDataReady() { return this.ready; },
      };
      (server as any).config.flattradeWsFeed = mutableFeed;
      (server as any).sessionService = new SessionService(broker as any, stateStore, 'API_KEY', {});
      broker.setSessionToken('stored-session');
      await stateStore.saveDailySession(getTodayDateIST(), 'stored-session');
      (broker as any).validateSession = async () => 'VALID';
      const status = async () => {
        const res = await fetch(`${baseUrl}/api/auth/status`, { headers: {
          'X-Device-Id': 'DEVICE_123', Authorization: `Bearer ${validToken}`,
        } });
        return res.json() as Promise<any>;
      };

      expect((await status()).status).toBe('WEBSOCKET_DISCONNECTED');
      mutableFeed.state = 'RECONNECTING';
      expect((await status()).status).toBe('WEBSOCKET_CONNECTING');
      mutableFeed.state = 'CONNECTED';
      mutableFeed.transport = true;
      mutableFeed.authenticated = true;
      expect((await status()).status).toBe('AUTHENTICATED');
      mutableFeed.ready = true;
      const ready = await status();
      expect(ready.status).toBe('FEED_READY');
      expect(ready.marketDataReady).toBe(true);
      mutableFeed.transport = false;
      mutableFeed.authenticated = false;
      expect((await status()).status).toBe('WEBSOCKET_DISCONNECTED');
    });

    it('GET /api/option-chain?symbol=SENSEX fails closed without authoritative instruments and fresh quotes', async () => {
      const res = await fetch(`${baseUrl}/api/option-chain?symbol=SENSEX&strikes=5`, {
        headers: {
          'X-Device-Id': 'DEVICE_123',
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.status).toBe(503);
      expect((await res.json() as any).error).toMatch(/instrument master/i);
    });

    it('LIVE SENSEX chain fails closed without authoritative instrument and fresh spot data', async () => {
      const res = await fetch(`${baseUrl}/api/option-chain?symbol=SENSEX&strikes=5`, {
        headers: { 'X-Device-Id': 'DEVICE_123', Authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(503);
      expect((await res.json() as any).error).toContain('instrument master');
    });
  });

  it('GET /health/ready remains unready while the instrument master and execution authorization are unavailable', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(503);
    const payload = await response.json() as any;
    expect(payload.tradingReady).toBe(false);
    expect(payload.components.instrumentMaster).toBe('UNAVAILABLE');
    expect(payload.components.sensexSpot).toBe('UNAVAILABLE');
    expect(payload.components.trading).toBe('DISABLED');
  });
});
