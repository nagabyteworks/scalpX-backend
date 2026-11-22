import Database from 'better-sqlite3';
import type {
  StateStorePort,
  OrderAuditRecord,
  ClosedTradeRecord,
} from '../../domain/ports/StateStorePort.js';
import type { LadderPosition, LadderPositionStatus } from '../../domain/models/LadderPosition.js';
import { TokenEncryption } from './TokenEncryption.js';
import { RiskStateStore, type DailyRiskState } from './RiskStateStore.js';

export class SqliteStateStore implements StateStorePort {
  private readonly db: Database.Database;
  private readonly queue: Array<() => void> = [];
  private isProcessing = false;
  private readonly tokenEncryption?: TokenEncryption;
  public readonly riskState: RiskStateStore;

  constructor(dbPath = ':memory:', encryptionKeyHex?: string) {
    this.db = new Database(dbPath);
    if (encryptionKeyHex) {
      this.tokenEncryption = new TokenEncryption(encryptionKeyHex);
    }
    this.riskState = new RiskStateStore(this.db);
    this.initDatabase();
  }

  private initDatabase(): void {
    // Zero-DB hot path pragma optimization
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 3000');

    // 1. daily_sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_sessions (
        trade_date TEXT PRIMARY KEY,
        token_encrypted_or_local TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // 2. active_ladders table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_ladders (
        token TEXT PRIMARY KEY,
        trading_symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        qty INTEGER NOT NULL,
        product TEXT NOT NULL,
        entry_price_paise INTEGER NOT NULL,
        next_milestone_paise INTEGER NOT NULL,
        step_size_paise INTEGER NOT NULL,
        breakout_buffer_paise INTEGER NOT NULL,
        slippage_buffer_paise INTEGER NOT NULL,
        active_sl_order_id TEXT,
        active_sl_trigger_paise INTEGER,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 3. order_audit_log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS order_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL,
        broker_order_id TEXT,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // 4. closed_trades table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS closed_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        trading_symbol TEXT NOT NULL,
        qty INTEGER NOT NULL,
        entry_paise INTEGER NOT NULL,
        exit_paise INTEGER NOT NULL,
        realized_pnl_paise INTEGER NOT NULL,
        closed_at INTEGER NOT NULL
      );
    `);

    // 5. daily_risk_state table (managed by RiskStateStore but also initialized here for safety)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_risk_state (
        trade_date TEXT PRIMARY KEY,
        realized_pnl_paise INTEGER NOT NULL DEFAULT 0,
        kill_switch_triggered INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);

    // 6. authorized_devices table (for device-bound provisioning and revocation)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authorized_devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_totp_step INTEGER
      );
    `);
    const deviceColumns = this.db.pragma('table_info(authorized_devices)') as Array<{ name: string }>;
    if (!deviceColumns.some((column) => column.name === 'last_totp_step')) {
      this.db.exec('ALTER TABLE authorized_devices ADD COLUMN last_totp_step INTEGER');
    }
  }

  /**
   * Lightweight async queue to execute DB writes off the hot tick path.
   */
  private enqueue<T>(task: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        try {
          const result = task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    queueMicrotask(() => {
      try {
        while (this.queue.length > 0) {
          const task = this.queue.shift();
          task?.();
        }
      } finally {
        this.isProcessing = false;
        if (this.queue.length > 0) {
          this.drainQueue();
        }
      }
    });
  }

  async savePosition(position: LadderPosition): Promise<void> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`
        INSERT INTO active_ladders (
          token, trading_symbol, exchange, qty, product, entry_price_paise,
          next_milestone_paise, step_size_paise, breakout_buffer_paise,
          slippage_buffer_paise, active_sl_order_id, active_sl_trigger_paise,
          status, updated_at
        ) VALUES (
          @token, @trading_symbol, @exchange, @qty, @product, @entry_price_paise,
          @next_milestone_paise, @step_size_paise, @breakout_buffer_paise,
          @slippage_buffer_paise, @active_sl_order_id, @active_sl_trigger_paise,
          @status, @updated_at
        )
        ON CONFLICT(token) DO UPDATE SET
          qty = excluded.qty,
          next_milestone_paise = excluded.next_milestone_paise,
          step_size_paise = excluded.step_size_paise,
          breakout_buffer_paise = excluded.breakout_buffer_paise,
          slippage_buffer_paise = excluded.slippage_buffer_paise,
          active_sl_order_id = excluded.active_sl_order_id,
          active_sl_trigger_paise = excluded.active_sl_trigger_paise,
          status = excluded.status,
          updated_at = excluded.updated_at
      `);

      stmt.run({
        token: position.token,
        trading_symbol: position.symbol,
        exchange: position.exchange,
        qty: position.quantity,
        product: 'I',
        entry_price_paise: position.entryPricePaise,
        next_milestone_paise: position.nextMilestonePaise,
        step_size_paise: position.stepSizePaise,
        breakout_buffer_paise: position.breakoutBufferPaise,
        slippage_buffer_paise: position.slippageBufferPaise,
        active_sl_order_id: position.activeSlOrderId,
        active_sl_trigger_paise: position.activeSlTriggerPaise,
        status: position.status,
        updated_at: position.updatedAt,
      });
    });
  }

  async updatePositionStatus(token: string, status: LadderPositionStatus): Promise<void> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`
        UPDATE active_ladders SET status = ?, updated_at = ? WHERE token = ?
      `);
      stmt.run(status, Date.now(), token);
    });
  }

  async recordOrderAudit(entry: OrderAuditRecord): Promise<void> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`
        INSERT INTO order_audit_log (
          command_id, broker_order_id, action, payload_json, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        entry.commandId,
        entry.orderId ?? null,
        entry.action,
        JSON.stringify(entry.details ?? {}),
        JSON.stringify({ status: entry.status, pricePaise: entry.pricePaise, triggerPricePaise: entry.triggerPricePaise }),
        entry.timestamp
      );
    });
  }

  async getPosition(token: string): Promise<LadderPosition | null> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`SELECT * FROM active_ladders WHERE token = ?`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = stmt.get(token) as any;
      if (!row) return null;

      return {
        token: row.token,
        symbol: row.trading_symbol,
        exchange: row.exchange,
        side: 'BUY',
        quantity: row.qty,
        entryPricePaise: row.entry_price_paise,
        nextMilestonePaise: row.next_milestone_paise,
        stepSizePaise: row.step_size_paise,
        breakoutBufferPaise: row.breakout_buffer_paise,
        slippageBufferPaise: row.slippage_buffer_paise,
        activeSlOrderId: row.active_sl_order_id,
        activeSlTriggerPaise: row.active_sl_trigger_paise,
        activeSlLimitPaise: null,
        isUpdating: false,
        status: row.status,
        isPaused: row.status !== 'OPEN',
        createdAt: row.updated_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async getAllActiveLadders(): Promise<LadderPosition[]> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`SELECT * FROM active_ladders WHERE status = 'OPEN'`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = stmt.all() as any[];

      return rows.map((row) => ({
        token: row.token,
        symbol: row.trading_symbol,
        exchange: row.exchange,
        side: 'BUY',
        quantity: row.qty,
        entryPricePaise: row.entry_price_paise,
        nextMilestonePaise: row.next_milestone_paise,
        stepSizePaise: row.step_size_paise,
        breakoutBufferPaise: row.breakout_buffer_paise,
        slippageBufferPaise: row.slippage_buffer_paise,
        activeSlOrderId: row.active_sl_order_id,
        activeSlTriggerPaise: row.active_sl_trigger_paise,
        activeSlLimitPaise: null,
        isUpdating: false,
        status: row.status,
        isPaused: false,
        createdAt: row.updated_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  /**
   * Saves the daily session token to SQLite.
   * In LIVE mode (encryptionKeyHex provided), the token is encrypted with AES-256-GCM.
   * Legacy rows from installations without encryption remain readable for migration.
   * Never logs the plaintext token.
   */
  async saveDailySession(tradeDate: string, plainToken: string): Promise<void> {
    const stored = this.tokenEncryption ? this.tokenEncryption.encrypt(plainToken) : plainToken;
    return this.enqueue(() => {
      const stmt = this.db.prepare(`
        INSERT INTO daily_sessions (trade_date, token_encrypted_or_local, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(trade_date) DO UPDATE SET
          token_encrypted_or_local = excluded.token_encrypted_or_local,
          created_at = excluded.created_at
      `);
      stmt.run(tradeDate, stored, Date.now());
    });
  }

  /**
   * Retrieves and decrypts the daily session token.
   * Returns null if no token exists, or if decryption fails (corrupted / wrong key).
   * Never logs the plaintext token.
   */
  async getDailySession(tradeDate: string): Promise<string | null> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`SELECT token_encrypted_or_local FROM daily_sessions WHERE trade_date = ?`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = stmt.get(tradeDate) as any;
      if (!row) return null;
      const stored: string = row.token_encrypted_or_local;

      if (!this.tokenEncryption) {
        // Paper mode — plaintext
        return stored;
      }

      // Live mode: attempt decryption
      if (!TokenEncryption.isEncrypted(stored)) {
        // Legacy plaintext token found — refuse to use it, force re-authentication
        console.warn('⚠️  Legacy plaintext session token detected in SQLite. Re-authentication required.');
        return null;
      }

      const decrypted = this.tokenEncryption.decrypt(stored);
      if (!decrypted) {
        console.warn('⚠️  Session token decryption failed (corrupted or wrong key). Re-authentication required.');
        return null;
      }

      return decrypted;
    });
  }

  async recordClosedTrade(trade: ClosedTradeRecord): Promise<void> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`
        INSERT INTO closed_trades (
          token, trading_symbol, qty, entry_paise, exit_paise, realized_pnl_paise, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        trade.token,
        trade.tradingSymbol,
        trade.qty,
        trade.entryPaise,
        trade.exitPaise,
        trade.realizedPnlPaise,
        trade.closedAt
      );
    });
  }

  /**
   * Saves daily risk state synchronously (called from RiskGuard on every P&L update).
   */
  saveRiskStateSync(state: DailyRiskState): void {
    this.riskState.saveRiskState(state);
  }

  getRiskStateSync(tradeDate: string): DailyRiskState | null {
    return this.riskState.getRiskState(tradeDate);
  }

  /**
   * Device Authorization & Provisioning Methods
   */
  async authorizeDevice(deviceId: string, name = 'Android Device'): Promise<void> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`
        INSERT INTO authorized_devices (device_id, name, created_at, revoked_at)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT(device_id) DO UPDATE SET
          name = excluded.name,
          revoked_at = NULL
      `);
      stmt.run(deviceId, name, Date.now());
    });
  }

  async isDeviceRevoked(deviceId: string): Promise<boolean> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`SELECT revoked_at FROM authorized_devices WHERE device_id = ?`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = stmt.get(deviceId) as any;
      if (!row) {
        // Device was never provisioned — treat as not authorized
        return false;
      }
      return row.revoked_at !== null;
    });
  }

  async isDeviceAuthorized(deviceId: string): Promise<boolean> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`SELECT device_id, revoked_at FROM authorized_devices WHERE device_id = ?`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = stmt.get(deviceId) as any;
      if (!row) return false;
      return row.revoked_at === null;
    });
  }

  async consumeDeviceTotpStep(deviceId: string, step: number): Promise<boolean> {
    return this.enqueue(() => {
      const result = this.db.prepare(`
        UPDATE authorized_devices
        SET last_totp_step = ?
        WHERE device_id = ? AND revoked_at IS NULL
          AND (last_totp_step IS NULL OR last_totp_step < ?)
      `).run(step, deviceId, step);
      return result.changes === 1;
    });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    return this.enqueue(() => {
      const stmt = this.db.prepare(`UPDATE authorized_devices SET revoked_at = ? WHERE device_id = ?`);
      stmt.run(Date.now(), deviceId);
    });
  }

  close(): void {
    this.db.close();
  }
}
