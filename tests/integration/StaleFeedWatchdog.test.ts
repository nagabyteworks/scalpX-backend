import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockFlattradeServer } from '../mock/MockFlattradeServer.js';
import { FlattradeWsAdapter } from '../../src/adapters/broker/FlattradeWsAdapter.js';
import type { Tick } from '../../src/domain/models/Tick.js';

describe('FlattradeWsAdapter & Stale-Feed Watchdog Integration', () => {
  let mockServer: MockFlattradeServer;
  let wsAdapter: FlattradeWsAdapter;
  let wsUrl: string;

  beforeEach(async () => {
    mockServer = new MockFlattradeServer({ sessionToken: 'WS_SESSION_TOKEN' });
    const urls = await mockServer.start();
    wsUrl = urls.wsUrl;
  });

  afterEach(async () => {
    wsAdapter?.destroy();
    await mockServer.stop();
  });

  it('connects, authenticates, receives touchline ticks, and converts to paise', async () => {
    wsAdapter = new FlattradeWsAdapter({
      wsUrl,
      userId: 'FT001',
      sessionToken: 'WS_SESSION_TOKEN',
      watchdogIntervalMs: 500,
      staleTimeoutMs: 1500,
      marketHoursOverride: false, // Normal connection test
    });

    const receivedTicks: Tick[] = [];
    wsAdapter.onTick((tick) => receivedTicks.push(tick));

    await wsAdapter.connect();
    expect(wsAdapter.isTransportConnected()).toBe(true);
    expect(wsAdapter.isAuthenticatedConnection()).toBe(true);
    expect(wsAdapter.isMarketDataReady()).toBe(false);
    await wsAdapter.subscribe(['NFO|26000']);

    // Broadcast tick from mock server
    mockServer.broadcastTick('NFO', '26000', '110.05', '110.00', '110.10');

    // Wait briefly for tick dispatch
    await new Promise((r) => setTimeout(r, 100));

    expect(receivedTicks.length).toBeGreaterThan(0);
    const tick = receivedTicks[0]!;
    expect(tick.token).toBe('26000');
    expect(tick.ltpPaise).toBe(11005); // 110.05 -> 11005 integer paise
    expect(tick.bestBidPaise).toBe(11000);
    expect(tick.bestAskPaise).toBe(11010);
    expect(wsAdapter.isMarketDataReady()).toBe(true);
  });

  it('rejects broker WebSocket authentication failure instead of remaining pending', async () => {
    const statusEvents: string[] = [];
    wsAdapter = new FlattradeWsAdapter({
      wsUrl,
      userId: 'FT001',
      sessionToken: 'WRONG_SESSION_TOKEN',
      watchdogIntervalMs: 500,
      staleTimeoutMs: 1500,
      marketHoursOverride: false,
    });
    wsAdapter.onStatus((status) => statusEvents.push(status));
    await expect(wsAdapter.connect()).rejects.toThrow('rejected WebSocket authentication');
    expect(wsAdapter.isAuthenticatedConnection()).toBe(false);
    expect(wsAdapter.isMarketDataReady()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(statusEvents).not.toContain('RECONNECTING');
  });

  it('triggers FEED_STALE after 3000ms silence in market hours, terminates, and reconnects', async () => {
    const statusEvents: string[] = [];

    wsAdapter = new FlattradeWsAdapter({
      wsUrl,
      userId: 'FT001',
      sessionToken: 'WS_SESSION_TOKEN',
      watchdogIntervalMs: 200,
      staleTimeoutMs: 600, // Reduced for test speed
      marketHoursOverride: true, // Force market hours active
    });

    wsAdapter.onStatus((status) => statusEvents.push(status));

    await wsAdapter.connect();
    await wsAdapter.subscribe(['NFO|26000']);

    expect(statusEvents).toContain('CONNECTED');

    // Do NOT send any ticks -> simulate feed silence
    // Wait for stale timeout (600ms) + watchdog interval (200ms) + margin
    await new Promise((r) => setTimeout(r, 1000));

    expect(statusEvents).toContain('FEED_STALE');
    expect(statusEvents).toContain('RECONNECTING');
    expect(wsAdapter.isMarketDataReady()).toBe(false);

    // Wait for backoff reconnect (500ms backoff)
    await new Promise((r) => setTimeout(r, 1200));

    // Reconnected successfully
    const connectedCount = statusEvents.filter((s) => s === 'CONNECTED').length;
    expect(connectedCount).toBeGreaterThanOrEqual(2);
  });

  it('sends BFO and NFO exchange-qualified subscriptions and preserves them on reconnect', async () => {
    wsAdapter = new FlattradeWsAdapter({
      wsUrl,
      userId: 'FT001',
      sessionToken: 'WS_SESSION_TOKEN',
      watchdogIntervalMs: 200,
      staleTimeoutMs: 600,
      marketHoursOverride: true,
    });
    await wsAdapter.subscribe(['BFO|901', 'NFO|902']);
    await wsAdapter.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mockServer.subscriptionMessages).toContain('BFO|901#NFO|902');
    expect(wsAdapter.isMarketDataReady()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(mockServer.subscriptionMessages.filter((msg) => msg === 'BFO|901#NFO|902').length).toBeGreaterThanOrEqual(2);
    expect(wsAdapter.isMarketDataReady()).toBe(true);
  });

  it('requires fresh ticks for every exchange-qualified subscription', async () => {
    await mockServer.stop();
    mockServer = new MockFlattradeServer({ sessionToken: 'WS_SESSION_TOKEN', acknowledgeSubscriptions: false });
    wsUrl = (await mockServer.start()).wsUrl;
    wsAdapter = new FlattradeWsAdapter({
      wsUrl, userId: 'FT001', sessionToken: 'WS_SESSION_TOKEN', marketHoursOverride: false,
    });
    await wsAdapter.connect();
    await expect(wsAdapter.subscribe(['901'])).rejects.toThrow('EXCHANGE|TOKEN');
    await wsAdapter.subscribe(['BFO|901', 'NFO|902']);
    mockServer.broadcastTick('BFO', '901', '110.00');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wsAdapter.isMarketDataReady()).toBe(false);
    mockServer.broadcastTick('NFO', '902', '110.00');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wsAdapter.isMarketDataReady()).toBe(true);
  });

  it('deduplicates subscriptions and resolves concurrent first-tick waiters from real feed events', async () => {
    await mockServer.stop();
    mockServer = new MockFlattradeServer({
      sessionToken: 'WS_SESSION_TOKEN',
      acknowledgeSubscriptions: false,
    });
    wsUrl = (await mockServer.start()).wsUrl;
    wsAdapter = new FlattradeWsAdapter({
      wsUrl,
      userId: 'FT001',
      sessionToken: 'WS_SESSION_TOKEN',
      marketHoursOverride: false,
      initialTickTimeoutMs: 500,
    });

    await wsAdapter.connect();
    await wsAdapter.subscribe(['BFO|901']);
    const first = wsAdapter.waitForTick('BFO|901');
    const second = wsAdapter.waitForTick('BFO|901');
    await wsAdapter.subscribe(['BFO|901', 'NFO|902']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockServer.subscriptionMessages).toEqual(['BFO|901', 'NFO|902']);

    mockServer.broadcastTick('BFO', '901', '110.25');
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { token: '901', ltpPaise: 11025 },
      { token: '901', ltpPaise: 11025 },
    ]);
  });

  it('cleans up timed-out first-tick waiters and reports a clear timeout', async () => {
    await mockServer.stop();
    mockServer = new MockFlattradeServer({
      sessionToken: 'WS_SESSION_TOKEN',
      acknowledgeSubscriptions: false,
    });
    wsUrl = (await mockServer.start()).wsUrl;
    wsAdapter = new FlattradeWsAdapter({
      wsUrl,
      userId: 'FT001',
      sessionToken: 'WS_SESSION_TOKEN',
      marketHoursOverride: false,
    });

    await wsAdapter.connect();
    await wsAdapter.subscribe(['NSE|26000']);
    await expect(wsAdapter.waitForTick('NSE|26000', 20))
      .rejects.toMatchObject({ code: 'INITIAL_TICK_NOT_RECEIVED' });

    mockServer.broadcastTick('NSE', '26000', '110.25');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wsAdapter.getLatestTick('NSE|26000')?.ltpPaise).toBe(11025);
  });

  it('rejects first-tick waiters immediately when the broker WebSocket disconnects', async () => {
    await mockServer.stop();
    mockServer = new MockFlattradeServer({
      sessionToken: 'WS_SESSION_TOKEN',
      acknowledgeSubscriptions: false,
    });
    wsUrl = (await mockServer.start()).wsUrl;
    wsAdapter = new FlattradeWsAdapter({
      wsUrl,
      userId: 'FT001',
      sessionToken: 'WS_SESSION_TOKEN',
      marketHoursOverride: false,
      initialTickTimeoutMs: 2000,
    });

    await wsAdapter.connect();
    await wsAdapter.subscribe(['NFO|26000']);
    const pendingTick = wsAdapter.waitForTick('NFO|26000');
    await mockServer.stop();
    mockServer = new MockFlattradeServer({ sessionToken: 'WS_SESSION_TOKEN' });
    wsUrl = (await mockServer.start()).wsUrl;

    await expect(pendingTick).rejects.toMatchObject({ code: 'WEBSOCKET_NOT_CONNECTED' });
  });
});
