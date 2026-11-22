import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockFlattradeServer } from '../mock/MockFlattradeServer.js';
import { FlattradeRestAdapter } from '../../src/adapters/broker/FlattradeRestAdapter.js';
import { SqliteStateStore } from '../../src/adapters/persistence/SqliteStateStore.js';
import { RatchetLadderEngine } from '../../src/domain/engines/RatchetLadderEngine.js';
import { ReconcilerService } from '../../src/application/ReconcilerService.js';
import type { MarketFeedPort } from '../../src/domain/ports/MarketFeedPort.js';
import type { LadderPosition } from '../../src/domain/models/LadderPosition.js';

describe('Crash-Restart Reconciliation Integration', () => {
  let mockServer: MockFlattradeServer;
  let restAdapter: FlattradeRestAdapter;
  let stateStore: SqliteStateStore;
  let engine: RatchetLadderEngine;
  let mockFeed: MarketFeedPort;
  let reconciler: ReconcilerService;
  let subscribedTokens: string[] = [];

  beforeEach(async () => {
    mockServer = new MockFlattradeServer({ sessionToken: 'RECON_SESSION' });
    const urls = await mockServer.start();

    stateStore = new SqliteStateStore(':memory:');

    restAdapter = new FlattradeRestAdapter({
      apiKey: 'KEY',
      apiSecret: 'SECRET',
      userId: 'FT001',
      sessionToken: 'RECON_SESSION',
      baseUrl: `${urls.httpUrl}/PiConnectAPI`,
      authUrl: `${urls.httpUrl}/trade/apitoken`,
    });

    engine = new RatchetLadderEngine(restAdapter, stateStore);
    subscribedTokens = [];

    mockFeed = {
      subscribe: async (tokens) => {
        subscribedTokens.push(...tokens);
      },
      unsubscribe: async () => {},
      onTick: () => {},
    };

    reconciler = new ReconcilerService(restAdapter, mockFeed, engine, stateStore);
  });

  afterEach(async () => {
    await restAdapter.close();
    await mockServer.stop();
    stateStore.close();
  });

  it('reconciles on startup: marks closed positions CLOSED, syncs open SL orders, and resubscribes tokens', async () => {
    // 1. Seed SQLite with 2 ladders from previous session before simulated crash
    const ladderA: LadderPosition = {
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
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
    };

    const ladderB: LadderPosition = {
      token: '26001',
      symbol: 'NIFTY26NOV24600CE',
      exchange: 'NFO',
      side: 'BUY',
      quantity: 50,
      entryPricePaise: 8000,
      nextMilestonePaise: 9000,
      stepSizePaise: 500,
      breakoutBufferPaise: 100,
      slippageBufferPaise: 150,
      activeSlOrderId: null,
      activeSlTriggerPaise: null,
      activeSlLimitPaise: null,
      isUpdating: false,
      status: 'OPEN',
      isPaused: false,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
    };

    await stateStore.savePosition(ladderA);
    await stateStore.savePosition(ladderB);

    // 2. Configure mock exchange books:
    // - Ladder A is still open with 50 net qty, and has an active SL-LMT order at 115.00 trigger
    // - Ladder B has 0 net qty (closed on exchange during downtime)
    mockServer.positionBook = [
      {
        stat: 'Ok',
        token: '26000',
        tsym: 'NIFTY26NOV24500CE',
        exch: 'NFO',
        netqty: '50',
      },
      {
        stat: 'Ok',
        token: '26001',
        tsym: 'NIFTY26NOV24600CE',
        exch: 'NFO',
        netqty: '0',
      },
    ];

    mockServer.orderBook = [
      {
        norenordno: 'SL_EXCHANGE_999',
        token: '26000',
        tsym: 'NIFTY26NOV24500CE',
        exch: 'NFO',
        status: 'TRIGGER_PENDING',
        prctyp: 'SL-LMT',
        trantype: 'S',
        qty: '50',
        prc: '113.50',
        trgprc: '115.00',
      },
    ];

    // 3. Run ReconcilerService on startup
    const summary = await reconciler.reconcile();

    expect(summary.checkedLadders).toBe(2);
    expect(summary.closedLadders).toBe(1); // Ladder B was closed
    expect(summary.syncedLadders).toBe(1); // Ladder A was synced

    // 4. Verify Ladder B is CLOSED in SQLite and NOT in active engine memory
    const posB = await stateStore.getPosition('26001');
    expect(posB?.status).toBe('CLOSED');
    expect(engine.getPosition('26001')).toBeUndefined();

    // 5. Verify Ladder A is OPEN with synced SL order ID and trigger price
    const posA = engine.getPosition('26000')!;
    expect(posA).toBeDefined();
    expect(posA.status).toBe('OPEN');
    expect(posA.activeSlOrderId).toBe('SL_EXCHANGE_999');
    expect(posA.activeSlTriggerPaise).toBe(11500); // 115.00 -> 11500 paise

    // 6. Verify token 26000 was re-subscribed to market feed
    expect(subscribedTokens).toContain('NFO|26000');
    expect(subscribedTokens).not.toContain('NFO|26001');
  });
});
