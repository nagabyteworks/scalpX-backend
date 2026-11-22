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
    await wsAdapter.subscribe(['26000']);

    // Broadcast tick from mock server
    mockServer.broadcastTick('26000', '110.05', '110.00', '110.10');

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
    wsAdapter = new FlattradeWsAdapter({
      wsUrl,
      userId: 'FT001',
      sessionToken: 'WRONG_SESSION_TOKEN',
      watchdogIntervalMs: 500,
      staleTimeoutMs: 1500,
      marketHoursOverride: false,
    });
    await expect(wsAdapter.connect()).rejects.toThrow('rejected WebSocket authentication');
    expect(wsAdapter.isAuthenticatedConnection()).toBe(false);
    expect(wsAdapter.isMarketDataReady()).toBe(false);
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
    await wsAdapter.subscribe(['26000']);

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
});
