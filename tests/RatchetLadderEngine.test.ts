import { describe, it, expect, beforeEach } from 'vitest';
import { RatchetLadderEngine, type RatchetAlertEvent } from '../src/domain/engines/RatchetLadderEngine.js';
import { PaperBrokerAdapter } from '../src/adapters/broker/PaperBrokerAdapter.js';
import type { LadderPosition } from '../src/domain/models/LadderPosition.js';

describe('RatchetLadderEngine Unit Tests', () => {
  let broker: PaperBrokerAdapter;
  let engine: RatchetLadderEngine;
  let alerts: RatchetAlertEvent[];

  beforeEach(() => {
    broker = new PaperBrokerAdapter();
    engine = new RatchetLadderEngine(broker);
    alerts = [];
    engine.onAlert((a) => alerts.push(a));
  });

  const createPosition = (overrides?: Partial<LadderPosition>): LadderPosition => ({
    token: '26000',
    symbol: 'NIFTY26NOV24500CE',
    exchange: 'NFO',
    side: 'BUY',
    quantity: 50,
    entryPricePaise: 10000, // 100.00
    nextMilestonePaise: 11000, // 110.00
    stepSizePaise: 500, // 5.00
    breakoutBufferPaise: 100, // 1.00
    slippageBufferPaise: 150, // 1.50
    activeSlOrderId: null,
    activeSlTriggerPaise: null,
    activeSlLimitPaise: null,
    isUpdating: false,
    status: 'OPEN',
    isPaused: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  it('keeps upside target levels strictly local and places only SL-LMT on breakout', async () => {
    const pos = createPosition();
    engine.registerPosition(pos);

    // Initial tick below threshold (11000 + 100 = 11100)
    broker.processTick({ token: '26000', ltpPaise: 10500, timestamp: Date.now() });
    await engine.onTick({ token: '26000', ltpPaise: 10500, timestamp: Date.now() });

    expect(broker.getPlaceCallCount()).toBe(0);
    expect(pos.activeSlOrderId).toBeNull();

    // Tick reaches breakout threshold (111.00)
    broker.processTick({ token: '26000', ltpPaise: 11100, timestamp: Date.now() });
    await engine.onTick({ token: '26000', ltpPaise: 11100, timestamp: Date.now() });

    expect(broker.getPlaceCallCount()).toBe(1);
    const placedOrder = broker.getAllOrders()[0]!;
    expect(placedOrder.orderType).toBe('SL-LMT'); // NEVER LMT sell order on upside target!
    expect(placedOrder.triggerPricePaise).toBe(11000); // 110.00
    expect(placedOrder.pricePaise).toBe(10850); // 108.50
    expect(pos.nextMilestonePaise).toBe(11500); // Advanced by stepSize
  });

  it('supports live configuration overrides mid-trade without cancelling exchange SL', () => {
    const pos = createPosition();
    engine.registerPosition(pos);

    engine.updateLadderConfig('26000', {
      nextMilestonePaise: 11200,
      stepSizePaise: 600,
      breakoutBufferPaise: 150,
    });

    const updated = engine.getPosition('26000')!;
    expect(updated.nextMilestonePaise).toBe(11200);
    expect(updated.stepSizePaise).toBe(600);
    expect(updated.breakoutBufferPaise).toBe(150);
  });

  it('marks position CLOSED when broker returns order already completed', async () => {
    const pos = createPosition({ activeSlOrderId: 'SL_NONEXISTENT' });
    engine.registerPosition(pos);

    // Try modifying an order that doesn't exist or is completed
    broker.processTick({ token: '26000', ltpPaise: 11200, timestamp: Date.now() });
    await engine.onTick({ token: '26000', ltpPaise: 11200, timestamp: Date.now() });

    // Order not found -> triggers CLOSED handling
    expect(engine.getPosition('26000')).toBeUndefined();
    expect(alerts.some((a) => a.type === 'POSITION_CLOSED')).toBe(true);
  });
});
