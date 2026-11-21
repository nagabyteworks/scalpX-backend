import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { Writable } from 'node:stream';
import { MockFlattradeServer } from './mock/MockFlattradeServer.js';
import { FlattradeRestAdapter } from '../src/adapters/broker/FlattradeRestAdapter.js';
import { FlattradeWsAdapter } from '../src/adapters/broker/FlattradeWsAdapter.js';
import { FlattradeAuthClient } from '../src/adapters/broker/FlattradeAuthClient.js';
import { SqliteStateStore } from '../src/adapters/persistence/SqliteStateStore.js';
import { SessionService, getTodayDateIST } from '../src/application/SessionService.js';
import { OrderManager } from '../src/application/OrderManager.js';
import { ReconcilerService } from '../src/application/ReconcilerService.js';
import { RatchetLadderEngine } from '../src/domain/engines/RatchetLadderEngine.js';
import { RiskGuard } from '../src/domain/engines/RiskGuard.js';
import { HttpServer } from '../src/adapters/transport/HttpServer.js';

describe('Daily OTP Login Flow (Server-Side 3-Step Handshake)', () => {
  const JWT_SECRET = 'test_jwt_secret_for_daily_login_123';
  const API_KEY = 'TEST_API_KEY_FT';
  const API_SECRET = 'TEST_API_SECRET_FT_XYZ';
  const USER_ID = 'FT12345';
  const PASSWORD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  let mockServer: MockFlattradeServer;
  let stateStore: SqliteStateStore;
  let restAdapter: FlattradeRestAdapter;
  let wsAdapter: FlattradeWsAdapter;
  let authClient: FlattradeAuthClient;
  let sessionService: SessionService;
  let orderManager: OrderManager;
  let reconciler: ReconcilerService;
  let engine: RatchetLadderEngine;
  let server: HttpServer;

  let httpUrl: string;
  let wsUrl: string;
  let serverBaseUrl: string;
  let validJwt: string;
  let logOutput: string;

  beforeEach(async () => {
    // 1. Start Mock Flattrade Server
    mockServer = new MockFlattradeServer({
      expectedApiKey: API_KEY,
      sessionToken: 'VERIFIED_DAILY_TOKEN_ABC',
    });
    const urls = await mockServer.start();
    httpUrl = urls.httpUrl;
    wsUrl = urls.wsUrl;

    // 2. Initialize In-Memory StateStore
    stateStore = new SqliteStateStore(':memory:');

    // 3. Flattrade Adapters wired to mock server
    restAdapter = new FlattradeRestAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      userId: USER_ID,
      baseUrl: `${httpUrl}/PiConnectAPI`,
      authUrl: `${httpUrl}/trade/apitoken`,
    });

    wsAdapter = new FlattradeWsAdapter({
      wsUrl: wsUrl,
      userId: USER_ID,
      sessionToken: '',
      marketHoursOverride: false, // Prevents tick timeout watchdog during tests
    });

    authClient = new FlattradeAuthClient({
      userId: USER_ID,
      passwordSha256: PASSWORD_SHA256,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      authBaseUrl: httpUrl,
      timeoutMs: 3000,
    });

    sessionService = new SessionService(restAdapter, stateStore, API_KEY, {
      brokerMode: 'live',
      authClient,
      wsFeed: wsAdapter,
      cooldownMs: 15000,
    });

    engine = new RatchetLadderEngine(restAdapter, stateStore);
    const riskGuard = new RiskGuard({
      lotSize: 25,
      maxLotsPerOrder: 4,
      maxOpenQtyPerSymbol: 200,
      maxDailyLossPaise: 500000,
    });

    orderManager = new OrderManager(restAdapter, wsAdapter, engine, riskGuard, stateStore);
    reconciler = new ReconcilerService(restAdapter, wsAdapter, engine, stateStore);
    sessionService.setReconciler(reconciler);

    // 4. Set up logger stream to verify secret redaction
    logOutput = '';
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logOutput += chunk.toString();
        callback();
      },
    });

    server = new HttpServer(
      {
        jwtSecret: JWT_SECRET,
        brokerMode: 'live',
        flattradeWsFeed: wsAdapter,
        logger: {
          level: 'info',
          stream: logStream,
          redact: {
            paths: [
              'req.body.otp',
              'body.otp',
              'otp',
              '*.api_secret',
              '*.Password',
              '*.jKey',
              '*.token',
              'headers.authorization',
            ],
            censor: '[REDACTED]',
          },
        },
      },
      sessionService,
      orderManager,
      reconciler,
      engine,
      stateStore,
      restAdapter
    );

    serverBaseUrl = await server.listen(0, '127.0.0.1');
    validJwt = jwt.sign({ sub: USER_ID }, JWT_SECRET, { algorithm: 'HS256' });
  });

  afterEach(async () => {
    await server.close();
    await authClient.close();
    wsAdapter.destroy();
    await restAdapter.close();
    await mockServer.stop();
    stateStore.close();
  });

  it('1. Full happy path (/auth/session -> /ftauth -> /trade/apitoken) persists token, connects WS, and returns 200 OK', async () => {
    const res = await fetch(`${serverBaseUrl}/api/auth/daily-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validJwt}`,
        'X-Device-Id': 'device-test-123',
      },
      body: JSON.stringify({ otp: '123456' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.brokerConnected).toBe(true);
    expect(body.tradeDate).toBe(getTodayDateIST());
    expect(body.tokenGeneratedAt).toBeDefined();

    // Verify token stored in SQLite WAL store
    const today = getTodayDateIST();
    const stored = await stateStore.getDailySession(today);
    expect(stored).toBe('VERIFIED_DAILY_TOKEN_ABC');

    // Verify Rest Adapter has token
    expect(restAdapter.getSessionToken()).toBe('VERIFIED_DAILY_TOKEN_ABC');

    // Verify mock server received all 3 auth calls
    const urls = mockServer.receivedRequests.map((r) => r.url);
    expect(urls.some((u) => u.includes('/auth/session'))).toBe(true);
    expect(urls.some((u) => u.includes('/ftauth'))).toBe(true);
    expect(urls.some((u) => u.includes('/trade/apitoken'))).toBe(true);
  });

  it('2. Invalid OTP returns 401 and activates 15-second retry cooldown (429 on immediate retry)', async () => {
    // Send invalid OTP
    const res1 = await fetch(`${serverBaseUrl}/api/auth/daily-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validJwt}`,
        'X-Device-Id': 'device-test-123',
      },
      body: JSON.stringify({ otp: '999999' }), // triggers invalid OTP in mock server
    });

    expect(res1.status).toBe(401);
    const body1 = (await res1.json()) as any;
    expect(body1.error).toContain('Invalid OTP');

    // Immediate retry with another OTP should hit 15s cooldown (429)
    const res2 = await fetch(`${serverBaseUrl}/api/auth/daily-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validJwt}`,
        'X-Device-Id': 'device-test-123',
      },
      body: JSON.stringify({ otp: '123456' }),
    });

    expect(res2.status).toBe(429);
    const body2 = (await res2.json()) as any;
    expect(body2.error).toContain('Too many failed login attempts');
    expect(body2.remainingSec).toBeGreaterThanOrEqual(1);
    expect(body2.remainingSec).toBeLessThanOrEqual(15);
  });

  it('3. Missing RedirectURL/code returns 502 with fallbackRequired: true', async () => {
    const res = await fetch(`${serverBaseUrl}/api/auth/daily-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validJwt}`,
        'X-Device-Id': 'device-test-123',
      },
      body: JSON.stringify({ otp: '888888' }), // triggers missing code in mock server
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.fallbackRequired).toBe(true);
    expect(body.error).toContain('Browser fallback required');
  });

  it('4. Non-6-digit OTP is rejected with 400 before any outbound call to Flattrade', async () => {
    const initialRequestCount = mockServer.receivedRequests.length;

    // Test with 4-digit OTP
    const res1 = await fetch(`${serverBaseUrl}/api/auth/daily-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validJwt}`,
        'X-Device-Id': 'device-test-123',
      },
      body: JSON.stringify({ otp: '1234' }),
    });

    expect(res1.status).toBe(400);
    const body1 = (await res1.json()) as any;
    expect(body1.error).toContain('6-digit numeric string');

    // Test with non-numeric string
    const res2 = await fetch(`${serverBaseUrl}/api/auth/daily-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validJwt}`,
        'X-Device-Id': 'device-test-123',
      },
      body: JSON.stringify({ otp: 'abcdef' }),
    });

    expect(res2.status).toBe(400);

    // Verify zero outbound calls reached mock Flattrade server
    expect(mockServer.receivedRequests.length).toBe(initialRequestCount);
  });

  it('5. Verifies neither OTP nor api_secret appears unredacted in logger output', async () => {
    const secretOtp = '654321';
    await fetch(`${serverBaseUrl}/api/auth/daily-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validJwt}`,
        'X-Device-Id': 'device-test-123',
      },
      body: JSON.stringify({ otp: secretOtp }),
    });

    // Check captured logs
    expect(logOutput).not.toContain(secretOtp);
    expect(logOutput).not.toContain(API_SECRET);
    expect(logOutput).not.toContain(PASSWORD_SHA256);
  });
});
