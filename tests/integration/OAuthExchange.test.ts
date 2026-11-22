import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockFlattradeServer } from '../mock/MockFlattradeServer.js';
import { FlattradeRestAdapter } from '../../src/adapters/broker/FlattradeRestAdapter.js';
import { SqliteStateStore } from '../../src/adapters/persistence/SqliteStateStore.js';
import { SessionService, getTodayDateIST } from '../../src/application/SessionService.js';

describe('OAuthExchange & SessionService Integration', () => {
  let mockServer: MockFlattradeServer;
  let stateStore: SqliteStateStore;
  let restAdapter: FlattradeRestAdapter;
  let sessionService: SessionService;
  let httpUrl: string;

  beforeEach(async () => {
    mockServer = new MockFlattradeServer({
      expectedApiKey: 'TEST_API_KEY_123',
      sessionToken: 'VERIFIED_SESSION_TOKEN_XYZ',
    });
    const urls = await mockServer.start();
    httpUrl = urls.httpUrl;

    stateStore = new SqliteStateStore(':memory:');

    restAdapter = new FlattradeRestAdapter({
      apiKey: 'TEST_API_KEY_123',
      apiSecret: 'SECRET_456',
      userId: 'FT001',
      baseUrl: `${httpUrl}/PiConnectAPI`,
      authUrl: `${httpUrl}/trade/apitoken`,
    });

    sessionService = new SessionService(restAdapter, stateStore, 'TEST_API_KEY_123', {});
  });

  afterEach(async () => {
    await restAdapter.close();
    await mockServer.stop();
    stateStore.close();
  });

  it('generates correct OAuth login URL', () => {
    const url = sessionService.getLoginUrl();
    expect(url).toBe('https://auth.flattrade.in/?app_key=TEST_API_KEY_123');
  });

  it('resolves the SENSEX spot token from the authenticated BSE index list, not a constant', async () => {
    await stateStore.saveDailySession(getTodayDateIST(), 'VERIFIED_SESSION_TOKEN_XYZ');
    restAdapter.setSessionToken('VERIFIED_SESSION_TOKEN_XYZ');
    expect(await sessionService.getSensexSpotInstrumentId()).toBe('BSE|987654321');
    const request = mockServer.receivedRequests.find((item) => item.url.endsWith('/GetIndexList'));
    expect(request).toBeDefined();
    expect(new URLSearchParams(request!.body).get('jData')).toContain('"exch":"BSE"');
  });

  it('exchanges OAuth request_code, stores token in SQLite, and updates broker client', async () => {
    const token = await sessionService.exchangeAndSaveToken('AUTH_CODE_789');
    expect(token).toBe('VERIFIED_SESSION_TOKEN_XYZ');
    expect(restAdapter.getSessionToken()).toBe('VERIFIED_SESSION_TOKEN_XYZ');

    // Verify stored in SQLite daily_sessions
    const today = getTodayDateIST();
    const stored = await stateStore.getDailySession(today);
    expect(stored).toBe('VERIFIED_SESSION_TOKEN_XYZ');
  });

  it('loads and remotely validates today token on restart without re-authenticating', async () => {
    const today = getTodayDateIST();
    await stateStore.saveDailySession(today, 'VERIFIED_SESSION_TOKEN_XYZ');

    // Create a fresh unauthenticated adapter & session service
    const freshAdapter = new FlattradeRestAdapter({
      apiKey: 'TEST_API_KEY_123',
      apiSecret: 'SECRET_456',
      userId: 'FT001',
      baseUrl: `${httpUrl}/PiConnectAPI`,
      authUrl: `${httpUrl}/trade/apitoken`,
    });
    const freshSessionService = new SessionService(freshAdapter, stateStore, 'TEST_API_KEY_123', {});

    const loadedToken = await freshSessionService.getValidTodaySession();
    expect(loadedToken).toBe('VERIFIED_SESSION_TOKEN_XYZ');
    expect(freshAdapter.getSessionToken()).toBe('VERIFIED_SESSION_TOKEN_XYZ');
    expect((await freshSessionService.getSessionState()).sessionValidity).toBe('VALID');

    await freshAdapter.close();
  });

  it('reports a stored but remotely expired token as present and invalid', async () => {
    const today = getTodayDateIST();
    await stateStore.saveDailySession(today, 'OLD_BUT_STORED_TOKEN');
    mockServer.sessionInvalid = true;

    const freshAdapter = new FlattradeRestAdapter({
      apiKey: 'TEST_API_KEY_123', apiSecret: 'SECRET_456', userId: 'FT001',
      baseUrl: `${httpUrl}/PiConnectAPI`, authUrl: `${httpUrl}/trade/apitoken`,
    });
    const freshSessionService = new SessionService(freshAdapter, stateStore, 'TEST_API_KEY_123', {});
    const loadedToken = await freshSessionService.getValidTodaySession();
    expect(loadedToken).toBeNull();
    expect(await freshSessionService.getSessionState()).toEqual({
      sessionTokenPresent: true,
      sessionValid: false,
      sessionValidity: 'INVALID',
    });
    await freshAdapter.close();
  });
});
