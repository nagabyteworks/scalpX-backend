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

  it('reports an unavailable broker session instead of returning an empty index list', async () => {
    await expect(restAdapter.getIndexList('NSE'))
      .rejects.toMatchObject({ code: 'BROKER_SESSION_UNAVAILABLE' });
  });

  it('resolves the SENSEX spot token from the authenticated BSE index list, not a constant', async () => {
    await stateStore.saveDailySession(getTodayDateIST(), 'VERIFIED_SESSION_TOKEN_XYZ');
    restAdapter.setSessionToken('VERIFIED_SESSION_TOKEN_XYZ');
    expect(await sessionService.getSensexSpotInstrumentId()).toBe('BSE|987654321');
    const request = mockServer.receivedRequests.find((item) => item.url.endsWith('/GetIndexList'));
    expect(request).toBeDefined();
    expect(new URLSearchParams(request!.body).get('jData')).toContain('"exch":"BSE"');
  });

  it('resolves documented Nifty 50 aliases and normalizes numeric tokens', async () => {
    restAdapter.setSessionToken('VERIFIED_SESSION_TOKEN_XYZ');
    mockServer.indexListResponse = {
      stat: 'Ok',
      values: [{ idxname: '  Nifty   50 ', token: 26000, symbol: 'NIFTY' }],
    };

    expect(await sessionService.getIndexSpotInstrumentId('NIFTY')).toBe('NSE|26000');
    expect((await restAdapter.getIndexList('NSE'))[0]).toMatchObject({
      idxname: 'Nifty 50',
      token: '26000',
      exchange: 'NSE',
    });
  });

  it('resolves the documented NIFTY BANK alias to its NSE index entry', async () => {
    restAdapter.setSessionToken('VERIFIED_SESSION_TOKEN_XYZ');
    mockServer.indexListResponse = {
      stat: 'Ok',
      values: [{ idxname: 'NIFTY BANK', token: '26009' }],
    };

    expect(await sessionService.getIndexSpotInstrumentId('NIFTY BANK')).toBe('NSE|26009');
  });

  it('rejects invalid and missing matching index tokens instead of silently treating the list as empty', async () => {
    restAdapter.setSessionToken('VERIFIED_SESSION_TOKEN_XYZ');
    mockServer.indexListResponse = {
      stat: 'Ok',
      values: [{ idxname: 'Nifty 50', token: 'not-a-token' }],
    };

    await expect(sessionService.getIndexSpotInstrumentId('NIFTY'))
      .rejects.toMatchObject({ code: 'INVALID_INDEX_TOKEN' });

    mockServer.indexListResponse = { stat: 'Ok', values: [{ idxname: 'Nifty 50' }] };
    const invalidTokenService = new SessionService(restAdapter, stateStore, 'TEST_API_KEY_123', {});
    await expect(invalidTokenService.getIndexSpotInstrumentId('NIFTY'))
      .rejects.toMatchObject({ code: 'INVALID_INDEX_TOKEN' });
  });

  it('reports missing indices, wrong exchanges and broker session errors explicitly', async () => {
    restAdapter.setSessionToken('VERIFIED_SESSION_TOKEN_XYZ');
    mockServer.indexListResponse = { stat: 'Ok', values: [] };
    await expect(sessionService.getIndexSpotInstrumentId('NIFTY'))
      .rejects.toMatchObject({ code: 'INDEX_NOT_FOUND' });

    mockServer.indexListResponse = {
      stat: 'Ok',
      values: [{ idxname: 'Nifty 50', token: '26000', exch: 'BSE' }],
    };
    await expect(sessionService.getIndexSpotInstrumentId('NIFTY'))
      .rejects.toMatchObject({ code: 'INVALID_INDEX_EXCHANGE' });

    mockServer.indexListResponse = {
      stat: 'Not_Ok',
      emsg: 'Session Expired : Invalid Session Key',
    };
    const failedSessionService = new SessionService(restAdapter, stateStore, 'TEST_API_KEY_123', {});
    await expect(failedSessionService.getIndexSpotInstrumentId('NIFTY'))
      .rejects.toMatchObject({ code: 'BROKER_SESSION_UNAVAILABLE' });
  });

  it('rejects multiple exact and alias candidates as ambiguous', async () => {
    restAdapter.setSessionToken('VERIFIED_SESSION_TOKEN_XYZ');
    mockServer.indexListResponse = {
      stat: 'Ok',
      values: [
        { idxname: 'NIFTY', token: '26000' },
        { idxname: 'Nifty 50', token: '26001' },
      ],
    };

    await expect(sessionService.getIndexSpotInstrumentId('NIFTY'))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_INDEX' });
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
