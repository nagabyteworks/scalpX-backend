import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { ClientWsHub } from '../../src/adapters/transport/ClientWsHub.js';
import { RatchetLadderEngine } from '../../src/domain/engines/RatchetLadderEngine.js';
import { MockBrokerAdapter } from '../mock/MockBrokerAdapter.js';
import type { AddressInfo } from 'node:net';

describe('ClientWsHub Throttled WebSocket Integration', () => {
  const JWT_SECRET = 'TEST_JWT_SECRET_WS';
  let server: http.Server;
  let hub: ClientWsHub;
  let engine: RatchetLadderEngine;
  let wsUrl: string;
  let validToken: string;

  beforeEach(async () => {
    server = http.createServer();
    const broker = new MockBrokerAdapter();
    engine = new RatchetLadderEngine(broker);

    hub = new ClientWsHub(
      {
        jwtSecret: JWT_SECRET,
        throttleIntervalMs: 50, // Fast interval for testing
      },
      engine
    );

    hub.attach(server);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
        resolve();
      });
    });

    validToken = jwt.sign({ sub: 'trader1', role: 'owner' }, JWT_SECRET, { algorithm: 'HS256' });
  });

  afterEach(async () => {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts direct app WebSocket connections without device or app authentication', async () => {
    const ws = new WebSocket(wsUrl);
    const firstMessage = await new Promise<string>((resolve) => {
      ws.on('message', (msg) => resolve(msg.toString()));
    });
    expect(JSON.parse(firstMessage).type).toBe('SNAPSHOT');
    ws.close();
  });

  it('authenticates and receives initial snapshot', async () => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${validToken}`
      },
    });

    const firstMessage = await new Promise<string>((resolve) => {
      ws.on('message', (msg) => resolve(msg.toString()));
    });

    const parsed = JSON.parse(firstMessage);
    expect(parsed.type).toBe('SNAPSHOT');
    expect(Array.isArray(parsed.positions)).toBe(true);

    ws.close();
  });

  it('coalesces ticks and broadcasts throttled snapshot every interval', async () => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${validToken}`
      },
    });

    // Register active position in engine
    engine.registerPosition({
      token: '26000',
      symbol: 'NIFTY26NOV24500CE',
      exchange: 'NFO',
      side: 'BUY',
      quantity: 50,
      entryPricePaise: 10000,
      nextMilestonePaise: 11000,
      stepSizePaise: 500,
      breakoutBufferPaise: 100,
      slippageBufferPaise: 150,
      activeSlOrderId: null,
      activeSlTriggerPaise: null,
      activeSlLimitPaise: null,
      isUpdating: false,
      status: 'OPEN',
      isPaused: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Update tick price in hub
    hub.updateTick({
      token: '26000',
      ltpPaise: 10500,
      timestamp: Date.now(),
    });

    const messages: any[] = [];
    ws.on('message', (msg) => {
      messages.push(JSON.parse(msg.toString()));
    });

    // Wait for at least 2 snapshot intervals (150ms)
    await new Promise((r) => setTimeout(r, 150));

    expect(messages.length).toBeGreaterThanOrEqual(2);
    const snap = messages[messages.length - 1];
    expect(snap.type).toBe('SNAPSHOT');
    expect(snap.positions[0].token).toBe('26000');
    expect(snap.positions[0].currentLtpPaise).toBe(10500);
    expect(snap.positions[0].unrealizedPnlPaise).toBe((10500 - 10000) * 50);

    ws.close();
  });

  it('broadcasts fresh spot and ATM CE/PE ticks and suppresses stale prices', async () => {
    const ws = new WebSocket(wsUrl);
    const marketMessages: any[] = [];
    ws.on('message', (message) => {
      const parsed = JSON.parse(message.toString());
      if (parsed.marketData) marketMessages.push(parsed.marketData);
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    hub.setFeedStatus('CONNECTED');
    hub.setMarketDataSelection({
      indexSymbol: 'SENSEX',
      spot: { token: '901', symbol: 'SENSEX', exchange: 'BSE', lotSize: null },
      expiry: '2026-11-26',
      atmStrike: 82000,
      call: { token: '910', symbol: 'SENSEX26NOV2682000CE', exchange: 'BFO', lotSize: 20 },
      put: { token: '911', symbol: 'SENSEX26NOV2682000PE', exchange: 'BFO', lotSize: 20 },
      strikes: [{
        strikePrice: 82000,
        call: { token: '910', symbol: 'SENSEX26NOV2682000CE', exchange: 'BFO', lotSize: 20 },
        put: { token: '911', symbol: 'SENSEX26NOV2682000PE', exchange: 'BFO', lotSize: 20 },
      }],
    });
    const timestamp = Date.now();
    hub.updateTick({ token: '901', exchange: 'BSE', ltpPaise: 8_200_000, timestamp });
    hub.updateTick({ token: '910', exchange: 'BFO', ltpPaise: 12_500, timestamp });
    hub.updateTick({ token: '911', exchange: 'BFO', ltpPaise: 11_250, timestamp });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const live = marketMessages.at(-1);
    expect(live).toMatchObject({
      indexSymbol: 'SENSEX',
      spotLtpPaise: 8_200_000,
      selectedExpiry: '2026-11-26',
      atmStrike: 82000,
      ceToken: '910',
      ceLtpPaise: 12_500,
      peToken: '911',
      peLtpPaise: 11_250,
      feedStatus: 'CONNECTED',
    });
    expect(live.marketDataTimestamp).toBe(timestamp);

    hub.updateTick({ token: '901', exchange: 'BSE', ltpPaise: 8_210_000, timestamp: Date.now() - 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stale = marketMessages.at(-1);
    expect(stale.spotLtpPaise).toBeNull();
    expect(stale.spotTimestamp).toBeNull();
    expect(stale.feedStatus).toBe('STALE');
    ws.close();
  });

  it('immediately pushes high-priority events bypassing throttle', async () => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${validToken}`,
        'X-Device-Id': 'DEVICE_001',
      },
    });

    await new Promise((r) => ws.on('open', r));

    const events: any[] = [];
    ws.on('message', (msg) => {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type !== 'SNAPSHOT') {
        events.push(parsed);
      }
    });

    // Broadcast critical events
    hub.broadcastEvent('ORDER_FILLED', { token: '26000', price: 10000 });
    hub.broadcastEvent('FEED_STALE', { message: 'Feed down' });

    await new Promise((r) => setTimeout(r, 50));

    expect(events.length).toBe(2);
    expect(events[0].type).toBe('ORDER_FILLED');
    expect(events[1].type).toBe('FEED_STALE');

    ws.close();
  });
});
