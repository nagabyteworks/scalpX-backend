import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RatchetLadderEngine, type RatchetAlertEvent } from '../src/domain/engines/RatchetLadderEngine.js';
import { PaperBrokerAdapter } from '../src/adapters/broker/PaperBrokerAdapter.js';
import { RiskGuard } from '../src/domain/engines/RiskGuard.js';
import type { LadderPosition } from '../src/domain/models/LadderPosition.js';

describe('Deterministic Tick-Replay Test Suite (Mandatory Test Cases)', () => {
  let broker: PaperBrokerAdapter;
  let engine: RatchetLadderEngine;
  let alerts: RatchetAlertEvent[];

  beforeEach(() => {
    broker = new PaperBrokerAdapter();
    engine = new RatchetLadderEngine(broker);
    alerts = [];
    engine.onAlert((a) => alerts.push(a));
  });

  /**
   * Helper to initialize a standard long option position:
   * Buy at 100.00, nextMilestone = 110.00, stepSize = 5.00, breakoutBuffer = 1.00, slippageBuffer = 1.50
   */
  const setupStandardLongPosition = (token = 'OPT_100'): LadderPosition => {
    const pos: LadderPosition = {
      token,
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
    };
    engine.registerPosition(pos);
    return pos;
  };

  /**
   * Test 1:
   * Buy at 100, milestone 110, step 5:
   * - tick 110.00 does NOT place/modify SL (prevents NSE rejecting Sell SL-LMT where trgprc >= ltp)
   * - tick 111.00 sets SL 110.00 / 108.50 and advances next milestone to 115.00
   */
  it('Test 1: Tick 110.00 does NOT place SL; Tick 111.00 sets SL 110.00/108.50 and advances milestone to 115.00', async () => {
    const pos = setupStandardLongPosition();

    // 1. Send tick at 110.00 (11000 paise).
    // Threshold is nextMilestone (11000) + breakoutBuffer (100) = 11100.
    // 11000 < 11100 -> Do nothing!
    broker.processTick({ token: pos.token, ltpPaise: 11000, timestamp: 1000 });
    await engine.onTick({ token: pos.token, ltpPaise: 11000, timestamp: 1000 });

    expect(broker.getPlaceCallCount()).toBe(0);
    expect(broker.getModifyCallCount()).toBe(0);
    expect(pos.activeSlOrderId).toBeNull();
    expect(pos.activeSlTriggerPaise).toBeNull();
    expect(pos.nextMilestonePaise).toBe(11000);

    // 2. Send tick at 111.00 (11100 paise).
    // 11100 >= 11100 -> Breakout confirmed!
    broker.processTick({ token: pos.token, ltpPaise: 11100, timestamp: 2000 });
    await engine.onTick({ token: pos.token, ltpPaise: 11100, timestamp: 2000 });

    expect(broker.getPlaceCallCount()).toBe(1);
    expect(broker.getModifyCallCount()).toBe(0);
    expect(pos.activeSlOrderId).not.toBeNull();
    expect(pos.activeSlTriggerPaise).toBe(11000); // 110.00
    expect(pos.activeSlLimitPaise).toBe(10850); // 108.50
    expect(pos.nextMilestonePaise).toBe(11500); // Advanced by stepSize (500) to 115.00

    const placedOrder = broker.getOrder(pos.activeSlOrderId!)!;
    expect(placedOrder.orderType).toBe('SL-LMT');
    expect(placedOrder.triggerPricePaise).toBe(11000);
    expect(placedOrder.pricePaise).toBe(10850);
  });

  /**
   * Test 2:
   * Gap-up spike 109.00 -> 122.00:
   * Fires exactly ONE broker call setting SL to 120.00 / 118.50 and next milestone to 125.00
   */
  it('Test 2: Gap-up spike 109.00 -> 122.00 fires exactly ONE broker call to SL 120.00/118.50 & milestone 125.00', async () => {
    const pos = setupStandardLongPosition();

    // Tick at 109.00
    broker.processTick({ token: pos.token, ltpPaise: 10900, timestamp: 1000 });
    await engine.onTick({ token: pos.token, ltpPaise: 10900, timestamp: 1000 });
    expect(broker.getPlaceCallCount()).toBe(0);

    // Sudden spike straight to 122.00 (12200 paise)
    // stepsCrossed = Math.floor((12200 - 100 - 11000) / 500) = Math.floor(1100 / 500) = 2
    // newSlTrigger = 11000 + 2 * 500 = 12000 (120.00)
    // newSlLimit = 12000 - 150 = 11850 (118.50)
    // nextMilestone = 12000 + 500 = 12500 (125.00)
    broker.processTick({ token: pos.token, ltpPaise: 12200, timestamp: 2000 });
    await engine.onTick({ token: pos.token, ltpPaise: 12200, timestamp: 2000 });

    expect(broker.getPlaceCallCount()).toBe(1); // Exactly ONE broker call
    expect(broker.getModifyCallCount()).toBe(0);
    expect(pos.activeSlTriggerPaise).toBe(12000); // 120.00
    expect(pos.activeSlLimitPaise).toBe(11850); // 118.50
    expect(pos.nextMilestonePaise).toBe(12500); // 125.00
  });

  /**
   * Test 3:
   * Drop 122.00 -> 119.50:
   * Triggers simulated SL fill and stops further modifications
   */
  it('Test 3: Drop 122.00 -> 119.50 triggers simulated SL fill and stops further modifications', async () => {
    const pos = setupStandardLongPosition();

    // Establish position at 122.00 with SL at 120.00 / 118.50
    broker.processTick({ token: pos.token, ltpPaise: 12200, timestamp: 1000 });
    await engine.onTick({ token: pos.token, ltpPaise: 12200, timestamp: 1000 });

    const slOrderId = pos.activeSlOrderId!;
    expect(broker.getOrder(slOrderId)?.status).toBe('OPEN');

    // Price drops to 119.50 (11950 paise)
    // 11950 <= triggerPrice (12000) and >= limitPrice (11850) -> SL FILLED by paper exchange!
    broker.processTick({ token: pos.token, ltpPaise: 11950, timestamp: 2000 });
    expect(broker.getOrder(slOrderId)?.status).toBe('FILLED');

    // When SL is filled on exchange, subsequent tick at 126.00 attempts modification,
    // which broker rejects with "Order already completed", marking position CLOSED and stopping modifications.
    broker.processTick({ token: pos.token, ltpPaise: 12600, timestamp: 3000 });
    await engine.onTick({ token: pos.token, ltpPaise: 12600, timestamp: 3000 });

    expect(engine.getPosition(pos.token)).toBeUndefined(); // Removed from active map
    expect(broker.getModifyCallCount()).toBe(1); // 1 attempt that was rejected by exchange
    expect(alerts.some((a) => a.type === 'POSITION_CLOSED')).toBe(true);

    // Any further ticks do NOT trigger broker calls
    broker.processTick({ token: pos.token, ltpPaise: 13000, timestamp: 4000 });
    await engine.onTick({ token: pos.token, ltpPaise: 13000, timestamp: 4000 });
    expect(broker.getModifyCallCount()).toBe(1); // Count stays 1, modifications completely stopped
  });

  /**
   * Test 4:
   * Concurrency test:
   * 5 rapid ticks above 111.00 while modifySlLimitOrder takes 150 ms fire exactly ONE broker call
   */
  it('Test 4: Concurrency test - 5 rapid ticks above 111.00 while in-flight take 150ms fire exactly ONE broker call', async () => {
    const pos = setupStandardLongPosition();

    // Initial placement at 111.00
    broker.processTick({ token: pos.token, ltpPaise: 11100, timestamp: 1000 });
    await engine.onTick({ token: pos.token, ltpPaise: 11100, timestamp: 1000 });
    expect(broker.getPlaceCallCount()).toBe(1);
    expect(broker.getModifyCallCount()).toBe(0);

    // Now introduce 150 ms broker latency for subsequent calls
    broker.setSimulatedLatency(150);

    // Advance price above next threshold (11500 + 100 = 11600)
    broker.processTick({ token: pos.token, ltpPaise: 11650, timestamp: 2000 });

    // Fire 5 rapid simultaneous onTick calls concurrently
    const tickPromises = [
      engine.onTick({ token: pos.token, ltpPaise: 11650, timestamp: 2001 }),
      engine.onTick({ token: pos.token, ltpPaise: 11660, timestamp: 2002 }),
      engine.onTick({ token: pos.token, ltpPaise: 11670, timestamp: 2003 }),
      engine.onTick({ token: pos.token, ltpPaise: 11680, timestamp: 2004 }),
      engine.onTick({ token: pos.token, ltpPaise: 11690, timestamp: 2005 }),
    ];

    await Promise.all(tickPromises);

    // Thanks to pos.isUpdating non-blocking mutex lock, exactly ONE modify call was dispatched!
    expect(broker.getModifyCallCount()).toBe(1);
    expect(pos.activeSlTriggerPaise).toBe(11500); // 115.00
    expect(pos.nextMilestonePaise).toBe(12000); // 120.00
  });

  /**
   * Test 5:
   * Rate limiter test:
   * EXIT_ALL executes ahead of queued MODIFY_SL calls
   */
  it('Test 5: Rate limiter test - EXIT_ALL executes ahead of queued MODIFY_SL calls', async () => {
    const riskGuard = new RiskGuard({
      lotSize: 25,
      maxLotsPerOrder: 4,
      maxOpenQtyPerSymbol: 200,
      maxDailyLossPaise: 100000,
      rateLimitCapacity: 1, // Restrict to 1 token capacity
      refillRatePerSec: 6,
    });

    const executionLog: string[] = [];

    // Exhaust current token
    await riskGuard.schedule('NORMAL', async () => {
      executionLog.push('ROUTINE_INIT');
    });

    // Bucket now empty. Queue multiple routine MODIFY_SL calls
    const mod1 = riskGuard.schedule('NORMAL', async () => {
      executionLog.push('MODIFY_SL_TOKEN_A');
    });
    const mod2 = riskGuard.schedule('NORMAL', async () => {
      executionLog.push('MODIFY_SL_TOKEN_B');
    });

    // Now issue emergency EXIT_ALL with HIGH priority
    const exitAll = riskGuard.schedule('HIGH', async () => {
      executionLog.push('EXIT_ALL_EMERGENCY');
    });

    await Promise.all([mod1, mod2, exitAll]);

    // High priority EXIT_ALL MUST execute before the queued NORMAL modifications
    expect(executionLog[0]).toBe('ROUTINE_INIT');
    expect(executionLog[1]).toBe('EXIT_ALL_EMERGENCY');
    expect(executionLog.slice(2)).toEqual(
      expect.arrayContaining(['MODIFY_SL_TOKEN_A', 'MODIFY_SL_TOKEN_B'])
    );

    riskGuard.destroy();
  });
});
