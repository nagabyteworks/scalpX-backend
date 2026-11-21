import { describe, it, expect, afterEach } from 'vitest';
import { RiskGuard, RiskViolationError } from '../src/domain/engines/RiskGuard.js';

describe('RiskGuard', () => {
  let riskGuard: RiskGuard;

  afterEach(() => {
    riskGuard?.destroy();
  });

  describe('Order & Quantity Validation', () => {
    it('allows orders within lot and open quantity limits', () => {
      riskGuard = new RiskGuard({
        lotSize: 25,
        maxLotsPerOrder: 4, // Max 100 qty
        maxOpenQtyPerSymbol: 200,
        maxDailyLossPaise: 500000, // 5000 Rs
      });

      expect(() => {
        riskGuard.validateOrder({
          symbol: 'NIFTY26NOV24500CE',
          quantity: 50, // 2 lots
          side: 'BUY',
          currentOpenQty: 0,
        });
      }).not.toThrow();
    });

    it('rejects orders exceeding maxLotsPerOrder', () => {
      riskGuard = new RiskGuard({
        lotSize: 25,
        maxLotsPerOrder: 2, // Max 50 qty
        maxOpenQtyPerSymbol: 200,
        maxDailyLossPaise: 500000,
      });

      expect(() => {
        riskGuard.validateOrder({
          symbol: 'NIFTY26NOV24500CE',
          quantity: 75, // 3 lots
          side: 'BUY',
          currentOpenQty: 0,
        });
      }).toThrow(RiskViolationError);
    });

    it('rejects orders exceeding maxOpenQtyPerSymbol', () => {
      riskGuard = new RiskGuard({
        lotSize: 25,
        maxLotsPerOrder: 4,
        maxOpenQtyPerSymbol: 100,
        maxDailyLossPaise: 500000,
      });

      expect(() => {
        riskGuard.validateOrder({
          symbol: 'NIFTY26NOV24500CE',
          quantity: 50,
          side: 'BUY',
          currentOpenQty: 75, // 75 + 50 = 125 > 100
        });
      }).toThrow(RiskViolationError);
    });
  });

  describe('Daily Loss & Kill Switch', () => {
    it('halts trading once cumulative loss hits or exceeds maxDailyLossPaise', () => {
      riskGuard = new RiskGuard({
        lotSize: 25,
        maxLotsPerOrder: 4,
        maxOpenQtyPerSymbol: 200,
        maxDailyLossPaise: 100000, // 1000 Rs
      });

      riskGuard.recordRealizedPnl(-50000); // -500 Rs
      expect(riskGuard.isKillSwitchTriggered()).toBe(false);

      riskGuard.recordRealizedPnl(-50000); // -1000 Rs total
      expect(riskGuard.isKillSwitchTriggered()).toBe(true);

      expect(() => {
        riskGuard.validateOrder({
          symbol: 'NIFTY26NOV24500CE',
          quantity: 25,
          side: 'BUY',
          currentOpenQty: 0,
        });
      }).toThrow(/kill switch/i);
    });
  });

  describe('Priority Rate Limiter', () => {
    it('executes HIGH priority tasks ahead of queued NORMAL priority tasks', async () => {
      riskGuard = new RiskGuard({
        lotSize: 25,
        maxLotsPerOrder: 4,
        maxOpenQtyPerSymbol: 200,
        maxDailyLossPaise: 100000,
        rateLimitCapacity: 1, // 1 token capacity
        refillRatePerSec: 6, // 1 token every ~166ms
      });

      const executionOrder: string[] = [];

      // Consume the initial 1 token
      await riskGuard.schedule('NORMAL', async () => {
        executionOrder.push('INITIAL_CALL');
      });

      // Now bucket has 0 tokens. Queue two NORMAL priority tasks
      const p1 = riskGuard.schedule('NORMAL', async () => {
        executionOrder.push('MODIFY_SL_1');
      });
      const p2 = riskGuard.schedule('NORMAL', async () => {
        executionOrder.push('MODIFY_SL_2');
      });

      // Queue one HIGH priority task (e.g. EXIT_ALL)
      const pHigh = riskGuard.schedule('HIGH', async () => {
        executionOrder.push('EXIT_ALL');
      });

      // Wait for all to resolve
      await Promise.all([p1, p2, pHigh]);

      // Verify that EXIT_ALL preempted the queued MODIFY_SL tasks
      expect(executionOrder[0]).toBe('INITIAL_CALL');
      expect(executionOrder[1]).toBe('EXIT_ALL'); // High priority preempted Normal
      expect(executionOrder).toContain('MODIFY_SL_1');
      expect(executionOrder).toContain('MODIFY_SL_2');
    });
  });
});
