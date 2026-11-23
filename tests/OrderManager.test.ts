import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderManager, type OneClickEntryParams } from '../src/application/OrderManager.js';
import { MockBrokerAdapter } from './mock/MockBrokerAdapter.js';
import { RatchetLadderEngine } from '../src/domain/engines/RatchetLadderEngine.js';
import { RiskGuard } from '../src/domain/engines/RiskGuard.js';
import { SqliteStateStore } from '../src/adapters/persistence/SqliteStateStore.js';
import type { MarketFeedPort } from '../src/domain/ports/MarketFeedPort.js';
import type { OrderResult } from '../src/domain/models/OrderIntent.js';

describe('OrderManager one-click entries', () => {
  const stores: SqliteStateStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function createManager() {
    const broker = new MockBrokerAdapter();
    const store = new SqliteStateStore(':memory:');
    stores.push(store);
    const engine = new RatchetLadderEngine(broker, store);
    const feed: MarketFeedPort = {
      subscribe: async () => {},
      unsubscribe: async () => {},
      onTick: () => {},
    };
    const manager = new OrderManager(broker, feed, engine, new RiskGuard(), store);
    return { broker, engine, manager };
  }

  const entryParams = (overrides: Partial<OneClickEntryParams> = {}): OneClickEntryParams => ({
    commandId: '550e8400-e29b-41d4-a716-446655440000',
    token: '810',
    symbol: 'SENSEX26NOV2682000PE',
    exchange: 'BFO',
    side: 'SELL',
    product: 'M',
    quantity: 20,
    ltpPaise: 10_000,
    bestBidPaise: 9_995,
    stepSizePaise: 500,
    breakoutBufferPaise: 100,
    slippageBufferPaise: 150,
    nextMilestonePaise: 9_000,
    initialSlTriggerPaise: 11_000,
    initialSlLimitPaise: 11_150,
    ...overrides,
  });

  it('submits the selected side/product and installs the opposite-side protective SL-LMT', async () => {
    const { broker, engine, manager } = createManager();
    const placeEntry = vi.spyOn(broker, 'placeLimitOrder').mockResolvedValue({
      orderId: 'ENTRY_1',
      status: 'FILLED',
      filledPricePaise: 10_000,
    });
    const placeStop = vi.spyOn(broker, 'placeSlLimitOrder').mockResolvedValue({
      orderId: 'SL_1',
      status: 'OPEN',
    });

    const position = await manager.enterPosition(entryParams());

    expect(placeEntry).toHaveBeenCalledWith(expect.objectContaining({
      exchange: 'BFO',
      side: 'SELL',
      product: 'M',
      orderType: 'LMT',
    }));
    expect(placeStop).toHaveBeenCalledWith(expect.objectContaining({
      exchange: 'BFO',
      side: 'BUY',
      product: 'M',
      orderType: 'SL-LMT',
      triggerPricePaise: 11_000,
      pricePaise: 11_150,
    }));
    expect(position).toMatchObject({ side: 'SELL', product: 'M', nextMilestonePaise: 9_000 });
    expect(engine.getPosition('810')?.side).toBe('SELL');
  });

  it('joins concurrent requests with the same command id instead of placing twice', async () => {
    const { broker, manager } = createManager();
    let releaseEntry: ((result: OrderResult) => void) | null = null;
    const placeEntry = vi.spyOn(broker, 'placeLimitOrder').mockImplementation(
      () => new Promise((resolve) => { releaseEntry = resolve; })
    );
    vi.spyOn(broker, 'placeSlLimitOrder').mockResolvedValue({ orderId: 'SL_2', status: 'OPEN' });

    const first = manager.enterPosition(entryParams({ commandId: '550e8400-e29b-41d4-a716-446655440001' }));
    await Promise.resolve();
    const duplicate = manager.enterPosition(entryParams({ commandId: '550e8400-e29b-41d4-a716-446655440001' }));
    expect(placeEntry).toHaveBeenCalledTimes(1);

    releaseEntry?.({ orderId: 'ENTRY_2', status: 'FILLED', filledPricePaise: 10_000 });
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).toBe(duplicateResult);
    expect(placeEntry).toHaveBeenCalledTimes(1);
  });
});
