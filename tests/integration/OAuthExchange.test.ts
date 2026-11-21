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

    sessionService = new SessionService(restAdapter, stateStore, 'TEST_API_KEY_123');
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

  it('exchanges OAuth request_code, stores token in SQLite, and updates broker client', async () => {
    const token = await sessionService.exchangeAndSaveToken('AUTH_CODE_789');
    expect(token).toBe('VERIFIED_SESSION_TOKEN_XYZ');
    expect(restAdapter.getSessionToken()).toBe('VERIFIED_SESSION_TOKEN_XYZ');

    // Verify stored in SQLite daily_sessions
    const today = getTodayDateIST();
    const stored = await stateStore.getDailySession(today);
    expect(stored).toBe('VERIFIED_SESSION_TOKEN_XYZ');
  });

  it('loads today valid token on restart without re-authenticating', async () => {
    const today = getTodayDateIST();
    await stateStore.saveDailySession(today, 'CACHED_SESSION_TOKEN');

    // Create a fresh unauthenticated adapter & session service
    const freshAdapter = new FlattradeRestAdapter({
      apiKey: 'TEST_API_KEY_123',
      apiSecret: 'SECRET_456',
      userId: 'FT001',
      baseUrl: `${httpUrl}/PiConnectAPI`,
      authUrl: `${httpUrl}/trade/apitoken`,
    });
    const freshSessionService = new SessionService(freshAdapter, stateStore, 'TEST_API_KEY_123');

    const loadedToken = await freshSessionService.getValidTodaySession();
    expect(loadedToken).toBe('CACHED_SESSION_TOKEN');
    expect(freshAdapter.getSessionToken()).toBe('CACHED_SESSION_TOKEN');

    await freshAdapter.close();
  });
});
