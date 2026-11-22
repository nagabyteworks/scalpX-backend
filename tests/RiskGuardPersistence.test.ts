import { describe, it, expect, afterEach } from 'vitest';
import { RiskGuard, RiskViolationError } from '../src/domain/engines/RiskGuard.js';

/**
 * In-memory mock persistence for RiskGuard testing.
 */
class MockRiskPersistence {
  private state: Record<string, unknown> = {};

  saveRiskStateSync(state: { tradeDate: string; realizedPnlPaise: number; killSwitchTriggered: boolean; updatedAt: number }) {
    this.state[state.tradeDate] = state;
  }

  getRiskStateSync(tradeDate: string) {
    return (this.state[tradeDate] as { realizedPnlPaise: number; killSwitchTriggered: boolean }) ?? null;
  }
}

describe('RiskGuard with Persistence', () => {
  let riskGuard: RiskGuard;

  afterEach(() => {
    riskGuard?.destroy();
  });

  it('restores daily P&L from persistence on startup', () => {
    const persistence = new MockRiskPersistence();

    // Simulate a previous session that recorded a loss
    const today = new Date().toISOString().split('T')[0]!;
    persistence.saveRiskStateSync({
      tradeDate: today,
      realizedPnlPaise: -40000, // -400 INR
      killSwitchTriggered: false,
      updatedAt: Date.now(),
    });

    // Create a fresh RiskGuard with the same persistence
    riskGuard = new RiskGuard(
      { lotSize: 25, maxLotsPerOrder: 4, maxOpenQtyPerSymbol: 200, maxDailyLossPaise: 100000 },
      persistence
    );

    expect(riskGuard.getRealizedPnlPaise()).toBe(-40000);
  });

  it('restores kill switch state from persistence and blocks new orders', () => {
    const persistence = new MockRiskPersistence();
    const today = new Date().toISOString().split('T')[0]!;
    persistence.saveRiskStateSync({
      tradeDate: today,
      realizedPnlPaise: -100000,
      killSwitchTriggered: true,
      updatedAt: Date.now(),
    });

    riskGuard = new RiskGuard(
      { lotSize: 25, maxLotsPerOrder: 4, maxOpenQtyPerSymbol: 200, maxDailyLossPaise: 100000 },
      persistence
    );

    expect(riskGuard.isKillSwitchTriggered()).toBe(true);
    expect(() => {
      riskGuard.validateOrder({ symbol: 'NIFTY26NOV24500CE', quantity: 25, side: 'BUY', currentOpenQty: 0 });
    }).toThrow(RiskViolationError);
  });

  it('persists updated P&L after each recordRealizedPnl call', () => {
    const persistence = new MockRiskPersistence();
    riskGuard = new RiskGuard(
      { lotSize: 25, maxLotsPerOrder: 4, maxOpenQtyPerSymbol: 200, maxDailyLossPaise: 100000 },
      persistence
    );

    riskGuard.recordRealizedPnl(-30000);
    riskGuard.recordRealizedPnl(-20000);

    // Simulate restart with same persistence
    const riskGuard2 = new RiskGuard(
      { lotSize: 25, maxLotsPerOrder: 4, maxOpenQtyPerSymbol: 200, maxDailyLossPaise: 100000 },
      persistence
    );
    expect(riskGuard2.getRealizedPnlPaise()).toBe(-50000);
    riskGuard2.destroy();
  });

  it('works without persistence (backward compatible)', () => {
    riskGuard = new RiskGuard({
      lotSize: 25,
      maxLotsPerOrder: 4,
      maxOpenQtyPerSymbol: 200,
      maxDailyLossPaise: 100000,
    });
    riskGuard.recordRealizedPnl(-50000);
    expect(riskGuard.getRealizedPnlPaise()).toBe(-50000);
    expect(riskGuard.isKillSwitchTriggered()).toBe(false);
    riskGuard.recordRealizedPnl(-50000);
    expect(riskGuard.isKillSwitchTriggered()).toBe(true);
  });
});
