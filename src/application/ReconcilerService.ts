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
}

export class ReconcilerService {
  private readonly broker: BrokerPort;
  private readonly feed: MarketFeedPort;
  private readonly engine: RatchetLadderEngine;
  private readonly stateStore: StateStorePort;

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

  /**
   * Reconciles local SQLite state with live Flattrade books on server startup & WS reconnect.
   */
  async reconcile(): Promise<ReconciliationSummary> {
    const savedLadders = await this.stateStore.getAllActiveLadders();
    if (savedLadders.length === 0) {
      return { checkedLadders: 0, closedLadders: 0, syncedLadders: 0, resubscribedTokens: [] };
    }

    // Fetch live broker state
    const [positions, orders] = await Promise.all([
      this.broker.getPositionBook(),
      this.broker.getOrderBook(),
    ]);

    let closedCount = 0;
    let syncedCount = 0;
    const tokensToSubscribe: string[] = [];

    for (const ladder of savedLadders) {
      // Find matching position in broker PositionBook
      const brokerPos = positions.find((p) => p.token === ladder.token || p.tsym === ladder.symbol);
      const netQty = brokerPos ? parseInt(brokerPos.netqty, 10) : 0;

      if (netQty === 0) {
        // Position was closed on exchange: mark CLOSED locally
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
        }

        ladder.quantity = netQty;
        ladder.status = 'OPEN';
        this.engine.registerPosition(ladder);
        await this.stateStore.savePosition(ladder);
        tokensToSubscribe.push(ladder.token);
        syncedCount++;
      }
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
    };
  }
}
