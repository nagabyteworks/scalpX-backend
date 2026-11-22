/**
 * RiskStateStore: Persists daily realized P&L and kill-switch state to SQLite.
 *
 * Required to prevent process restarts from resetting daily loss protection.
 * Uses the exchange trading date in Asia/Kolkata timezone.
 */
import Database from 'better-sqlite3';

export interface DailyRiskState {
  tradeDate: string;      // 'YYYY-MM-DD' in IST
  realizedPnlPaise: number;
  killSwitchTriggered: boolean;
  updatedAt: number;
}

export class RiskStateStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_risk_state (
        trade_date TEXT PRIMARY KEY,
        realized_pnl_paise INTEGER NOT NULL DEFAULT 0,
        kill_switch_triggered INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  saveRiskState(state: DailyRiskState): void {
    const stmt = this.db.prepare(`
      INSERT INTO daily_risk_state (trade_date, realized_pnl_paise, kill_switch_triggered, updated_at)
      VALUES (@trade_date, @realized_pnl_paise, @kill_switch_triggered, @updated_at)
      ON CONFLICT(trade_date) DO UPDATE SET
        realized_pnl_paise = excluded.realized_pnl_paise,
        kill_switch_triggered = excluded.kill_switch_triggered,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      trade_date: state.tradeDate,
      realized_pnl_paise: state.realizedPnlPaise,
      kill_switch_triggered: state.killSwitchTriggered ? 1 : 0,
      updated_at: state.updatedAt,
    });
  }

  getRiskState(tradeDate: string): DailyRiskState | null {
    const stmt = this.db.prepare(`SELECT * FROM daily_risk_state WHERE trade_date = ?`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = stmt.get(tradeDate) as any;
    if (!row) return null;
    return {
      tradeDate: row.trade_date,
      realizedPnlPaise: row.realized_pnl_paise,
      killSwitchTriggered: row.kill_switch_triggered === 1,
      updatedAt: row.updated_at,
    };
  }
}
