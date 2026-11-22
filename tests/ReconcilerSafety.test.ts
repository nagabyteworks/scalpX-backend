import { describe, it, expect } from 'vitest';
import { ReconcilerService } from '../src/application/ReconcilerService.js';
import { RatchetLadderEngine } from '../src/domain/engines/RatchetLadderEngine.js';
import { SqliteStateStore } from '../src/adapters/persistence/SqliteStateStore.js';
import type { BrokerPort } from '../src/domain/ports/BrokerPort.js';
import type { MarketFeedPort } from '../src/domain/ports/MarketFeedPort.js';
import type { LadderPosition } from '../src/domain/models/LadderPosition.js';

const mockFeed: MarketFeedPort = {
  subscribe: async () => {},
  unsubscribe: async () => {},
  onTick: () => {},
};

function makeLadder(overrides?: Partial<LadderPosition>): LadderPosition {
  return {
    token: 'TOKEN1',
    symbol: 'NIFTY26NOV24500CE',
    exchange: 'NFO',
    side: 'BUY',
    quantity: 50,
    entryPricePaise: 10000,
    nextMilestonePaise: 11000,
    stepSizePaise: 500,
    breakoutBufferPaise: 100,
    slippageBufferPaise: 150,
    activeSlOrderId: 'SL_123',
    activeSlTriggerPaise: 10500,
    activeSlLimitPaise: 10350,
    isUpdating: false,
    status: 'OPEN',
    isPaused: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('ReconcilerService Safety', () => {
  it('marks account state uncertain when broker API throws — does NOT close positions', async () => {
    const store = new SqliteStateStore(':memory:');
    const ladder = makeLadder();
    await store.savePosition(ladder);

    const failingBroker: BrokerPort = {
      placeLimitOrder: async () => { throw new Error('timeout'); },
      placeSlLimitOrder: async () => { throw new Error('timeout'); },
      modifySlLimitOrder: async () => { throw new Error('timeout'); },
      cancelOrder: async () => { throw new Error('timeout'); },
      exitPosition: async () => { throw new Error('timeout'); },
      exitAllPositions: async () => { throw new Error('timeout'); },
      getOrderBook: async () => { throw new Error('timeout'); },
      getPositionBook: async () => { throw new Error('timeout'); },
      getQuotes: async () => { throw new Error('timeout'); },
    };

    const engine = new RatchetLadderEngine(failingBroker, store);
    const reconciler = new ReconcilerService(failingBroker, mockFeed, engine, store);

    const summary = await reconciler.reconcile();

    expect(summary.uncertain).toBe(true);
    expect(summary.closedLadders).toBe(0); // Must NOT have closed position on API failure
    expect(summary.uncertainTokens).toContain('TOKEN1');
    expect(reconciler.isAccountStateUncertain).toBe(true);
    store.close();
  });

  it('marks position CLOSED when broker confirms netQty === 0', async () => {
    const store = new SqliteStateStore(':memory:');
    const ladder = makeLadder();
    await store.savePosition(ladder);

    const broker: BrokerPort = {
      placeLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      placeSlLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      modifySlLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      cancelOrder: async () => {},
      exitPosition: async () => ({ orderId: '1', status: 'FILLED' }),
      exitAllPositions: async () => {},
      getOrderBook: async () => [],
      getPositionBook: async () => [
        // netqty = '0' means position is closed on exchange
        { stat: 'Ok', token: 'TOKEN1', tsym: 'NIFTY26NOV24500CE', exch: 'NFO', netqty: '0' },
      ],
      getQuotes: async () => ({ stat: 'Ok', token: 'TOKEN1', lp: '100.00' }),
    };

    const engine = new RatchetLadderEngine(broker, store);
    const reconciler = new ReconcilerService(broker, mockFeed, engine, store);

    const summary = await reconciler.reconcile();

    expect(summary.closedLadders).toBe(1);
    expect(summary.uncertain).toBe(false);
    store.close();
  });

  it('keeps position open when broker shows netQty > 0 and syncs SL order', async () => {
    const store = new SqliteStateStore(':memory:');
    const ladder = makeLadder();
    await store.savePosition(ladder);

    const broker: BrokerPort = {
      placeLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      placeSlLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      modifySlLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      cancelOrder: async () => {},
      exitPosition: async () => ({ orderId: '1', status: 'FILLED' }),
      exitAllPositions: async () => {},
      getOrderBook: async () => [
        {
          norenordno: 'SL_BROKER_456',
          exch: 'NFO',
          tsym: 'NIFTY26NOV24500CE',
          token: 'TOKEN1',
          status: 'TRIGGER_PENDING',
          prctyp: 'SL-LMT',
          trantype: 'S',
          qty: '50',
          prc: '103.50',
          trgprc: '105.00',
        },
      ],
      getPositionBook: async () => [
        { stat: 'Ok', token: 'TOKEN1', tsym: 'NIFTY26NOV24500CE', exch: 'NFO', netqty: '50' },
      ],
      getQuotes: async () => ({ stat: 'Ok', token: 'TOKEN1', lp: '110.00' }),
    };

    const engine = new RatchetLadderEngine(broker, store);
    const reconciler = new ReconcilerService(broker, mockFeed, engine, store);

    const summary = await reconciler.reconcile();

    expect(summary.syncedLadders).toBe(1);
    expect(summary.closedLadders).toBe(0);
    expect(summary.uncertain).toBe(false);
    // SL order should be synced from broker
    const pos = engine.getPosition('TOKEN1');
    expect(pos?.activeSlOrderId).toBe('SL_BROKER_456');
    store.close();
  });

  it('is idempotent — running reconcile twice gives the same result', async () => {
    const store = new SqliteStateStore(':memory:');
    const ladder = makeLadder();
    await store.savePosition(ladder);

    const broker: BrokerPort = {
      placeLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      placeSlLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      modifySlLimitOrder: async () => ({ orderId: '1', status: 'OPEN' }),
      cancelOrder: async () => {},
      exitPosition: async () => ({ orderId: '1', status: 'FILLED' }),
      exitAllPositions: async () => {},
      getOrderBook: async () => [],
      getPositionBook: async () => [
        { stat: 'Ok', token: 'TOKEN1', tsym: 'NIFTY26NOV24500CE', exch: 'NFO', netqty: '50' },
      ],
      getQuotes: async () => ({ stat: 'Ok', token: 'TOKEN1', lp: '110.00' }),
    };

    const engine = new RatchetLadderEngine(broker, store);
    const reconciler = new ReconcilerService(broker, mockFeed, engine, store);

    const s1 = await reconciler.reconcile();
    const s2 = await reconciler.reconcile();

    expect(s1.syncedLadders).toBe(s2.syncedLadders);
    expect(s1.uncertain).toBe(s2.uncertain);
    store.close();
  });
});
