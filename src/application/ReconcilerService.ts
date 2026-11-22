import type { BrokerPort } from '../domain/ports/BrokerPort.js';
import type { MarketFeedPort } from '../domain/ports/MarketFeedPort.js';
import type { StateStorePort } from '../domain/ports/StateStorePort.js';
import type { RatchetLadderEngine } from '../domain/engines/RatchetLadderEngine.js';
import { toPaise } from '../domain/models/Money.js';

export interface ReconciliationSummary {
  checkedLadders: number;
  closedLadders: number;
  syncedLadders: number;
  resubscribedTokens: string[];
  uncertain: boolean; // true if broker state could not be fully verified
  uncertainTokens: string[];
}

/**
 * Signals that broker state cannot be verified and new entries must be blocked.
 */
export class ReconciliationUncertainError extends Error {
  constructor(public readonly tokens: string[], cause?: unknown) {
    super(`Broker state uncertain for tokens: [${tokens.join(', ')}]. New entries blocked.`);
    this.name = 'ReconciliationUncertainError';
    if (cause) {
      this.stack += `\nCaused by: ${cause instanceof Error ? cause.stack : String(cause)}`;
    }
  }
}

export class ReconcilerService {
  private readonly broker: BrokerPort;
  private readonly feed: MarketFeedPort;
  private readonly engine: RatchetLadderEngine;
  private readonly stateStore: StateStorePort;

  /**
   * When true, new entry orders must be blocked until reconciliation succeeds.
   * Set to true whenever broker state cannot be verified.
   */
  private _isAccountStateUncertain = false;
  private _uncertainTokens: string[] = [];

  constructor(
    broker: BrokerPort,
    feed: MarketFeedPort,
    engine: RatchetLadderEngine,
    stateStore: StateStorePort
  ) {
    this.broker = broker;
    this.feed = feed;
    this.engine = engine;
    this.stateStore = stateStore;
  }

  get isAccountStateUncertain(): boolean {
    return this._isAccountStateUncertain;
  }

  get uncertainTokens(): string[] {
    return [...this._uncertainTokens];
  }

  /**
   * Reconciles local SQLite state with live Flattrade books on server startup & WS reconnect.
   *
   * CRITICAL SAFETY RULES:
   * 1. If the broker PositionBook API call fails (timeout, error, malformed response),
   *    we MUST NOT treat this as "no positions". Instead, mark account state as uncertain,
   *    preserve local state, block new entries, and raise an alert.
   * 2. Only mark a position as CLOSED when the broker explicitly shows netQty === 0
   *    AND the broker API call itself succeeded (no error thrown).
   * 3. Reconciliation is idempotent.
   */
  async reconcile(): Promise<ReconciliationSummary> {
    const savedLadders = await this.stateStore.getAllActiveLadders();
    if (savedLadders.length === 0) {
      this._isAccountStateUncertain = false;
      this._uncertainTokens = [];
      return {
        checkedLadders: 0,
        closedLadders: 0,
        syncedLadders: 0,
        resubscribedTokens: [],
        uncertain: false,
        uncertainTokens: [],
      };
    }

    // Fetch live broker state — if this fails, do NOT proceed as if positions are closed
    let positions;
    let orders;
    try {
      [positions, orders] = await Promise.all([
        this.broker.getPositionBook(),
        this.broker.getOrderBook(),
      ]);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const affectedTokens = savedLadders.map((l) => l.token);

      // Mark account state as uncertain — block new entries
      this._isAccountStateUncertain = true;
      this._uncertainTokens = affectedTokens;

      console.error(
        `❌ ReconcilerService: Broker API call FAILED during reconciliation: ${errMsg}. ` +
          `Account state is UNCERTAIN for tokens: [${affectedTokens.join(', ')}]. ` +
          'Preserving local state. New entries BLOCKED until reconciliation succeeds.'
      );

      return {
        checkedLadders: savedLadders.length,
        closedLadders: 0,
        syncedLadders: 0,
        resubscribedTokens: [],
        uncertain: true,
        uncertainTokens: affectedTokens,
      };
    }

    let closedCount = 0;
    let syncedCount = 0;
    const tokensToSubscribe: string[] = [];
    const uncertainTokens: string[] = [];

    for (const ladder of savedLadders) {
      // Find matching position in broker PositionBook
      const brokerPos = positions.find((p) => p.token === ladder.token || p.tsym === ladder.symbol);
      if (brokerPos?.exch) ladder.exchange = brokerPos.exch;
      const netQty = brokerPos ? parseInt(brokerPos.netqty, 10) : 0;

      // NaN check: a malformed netqty field must NOT be treated as 0 (closed)
      if (brokerPos && isNaN(netQty)) {
        console.warn(
          `⚠️  ReconcilerService: Malformed netqty "${brokerPos.netqty}" for token ${ladder.token}. ` +
            'Marking as uncertain to avoid accidental position closure.'
        );
        uncertainTokens.push(ladder.token);
        // Keep ladder registered as OPEN in memory — do not close it
        this.engine.registerPosition(ladder);
        tokensToSubscribe.push(`${ladder.exchange}|${ladder.token}`);
        continue;
      }

      if (netQty === 0 && !brokerPos) {
        // No matching broker position — could be legitimately closed, or token mismatch.
        // Safe to mark as CLOSED only if position book API itself succeeded (it did, no catch above).
        ladder.status = 'CLOSED';
        this.engine.removePosition(ladder.token);
        await this.stateStore.updatePositionStatus(ladder.token, 'CLOSED');
        closedCount++;
      } else if (netQty === 0 && brokerPos) {
        // Broker explicitly shows net qty = 0 — position is confirmed closed
        ladder.status = 'CLOSED';
        this.engine.removePosition(ladder.token);
        await this.stateStore.updatePositionStatus(ladder.token, 'CLOSED');
        closedCount++;
      } else {
        // Position is open: find active SL-LMT order in OrderBook
        const activeSlOrder = orders.find(
          (o) =>
            (o.token === ladder.token || o.tsym === ladder.symbol) &&
            (o.status === 'OPEN' || o.status === 'TRIGGER_PENDING') &&
            o.prctyp === 'SL-LMT' &&
            o.trantype === 'S'
        );

        if (activeSlOrder) {
          ladder.activeSlOrderId = activeSlOrder.norenordno;
          if (activeSlOrder.trgprc) {
            ladder.activeSlTriggerPaise = toPaise(activeSlOrder.trgprc);
          }
        } else {
          // Open position with no protective SL — this is a HIGH-RISK state
          console.error(
            `⛔ ReconcilerService: OPEN position ${ladder.token} (${ladder.symbol}) has NO active SL-LMT order! ` +
              'Position will be ratcheted but entry of new positions should be reviewed.'
          );
        }

        ladder.quantity = netQty;
        ladder.status = 'OPEN';
        this.engine.registerPosition(ladder);
        await this.stateStore.savePosition(ladder);
        tokensToSubscribe.push(`${ladder.exchange}|${ladder.token}`);
        syncedCount++;
      }
    }

    // Update uncertain state
    if (uncertainTokens.length > 0) {
      this._isAccountStateUncertain = true;
      this._uncertainTokens = uncertainTokens;
    } else {
      this._isAccountStateUncertain = false;
      this._uncertainTokens = [];
    }

    // Resubscribe active tokens to market feed
    if (tokensToSubscribe.length > 0) {
      await this.feed.subscribe(tokensToSubscribe);
    }

    return {
      checkedLadders: savedLadders.length,
      closedLadders: closedCount,
      syncedLadders: syncedCount,
      resubscribedTokens: tokensToSubscribe,
      uncertain: this._isAccountStateUncertain,
      uncertainTokens: this._uncertainTokens,
    };
  }
}
