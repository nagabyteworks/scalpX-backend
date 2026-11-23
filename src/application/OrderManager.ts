import type { BrokerPort } from '../domain/ports/BrokerPort.js';
import type { MarketFeedPort } from '../domain/ports/MarketFeedPort.js';
import type { StateStorePort } from '../domain/ports/StateStorePort.js';
import type { RatchetLadderEngine } from '../domain/engines/RatchetLadderEngine.js';
import type { RiskGuard } from '../domain/engines/RiskGuard.js';
import { MarketableLimitPricer, type PricingBufferConfig } from '../domain/engines/MarketableLimitPricer.js';
import type { LadderPosition } from '../domain/models/LadderPosition.js';
import type { OrderUpdateEvent } from '../adapters/broker/FlattradeProtocol.js';
import { toPaise } from '../domain/models/Money.js';
import type { OrderSide } from '../domain/models/OrderIntent.js';

export interface OneClickEntryParams {
  commandId: string;
  token: string;
  symbol: string;
  exchange: string;
  side?: OrderSide;
  product?: 'I' | 'M';
  quantity: number;
  ltpPaise: number;
  bestAskPaise?: number;
  bestBidPaise?: number;
  pricingBuffer?: PricingBufferConfig;
  stepSizePaise: number;
  breakoutBufferPaise: number;
  slippageBufferPaise: number;
  nextMilestonePaise?: number;
  initialSlLimitPaise?: number;
  initialSlTriggerPaise?: number;
}

export interface ExitResult {
  token: string;
  commandId: string;
  orderId: string;
  status: string;
}

export class OrderManager {
  private readonly broker: BrokerPort;
  private readonly feed: MarketFeedPort;
  private readonly engine: RatchetLadderEngine;
  private readonly riskGuard: RiskGuard;
  private readonly stateStore: StateStorePort;

  // 60-second commandId deduplication cache
  private readonly processedCommands = new Map<string, { timestamp: number; result: unknown }>();
  private readonly inFlightEntries = new Map<string, Promise<LadderPosition>>();
  private readonly inFlightEntryTokens = new Set<string>();

  // In-flight order fill listeners
  private readonly pendingFills = new Map<string, (update: OrderUpdateEvent) => void>();

  constructor(
    broker: BrokerPort,
    feed: MarketFeedPort,
    engine: RatchetLadderEngine,
    riskGuard: RiskGuard,
    stateStore: StateStorePort
  ) {
    this.broker = broker;
    this.feed = feed;
    this.engine = engine;
    this.riskGuard = riskGuard;
    this.stateStore = stateStore;

    // Periodically clean up deduplication cache
    setInterval(() => this.cleanupCommandCache(), 30000).unref();
  }

  handleOrderUpdate(update: OrderUpdateEvent): void {
    const waiter = this.pendingFills.get(update.norenordno);
    if (waiter) {
      waiter(update);
    }
  }

  private cleanupCommandCache(): void {
    const now = Date.now();
    for (const [cmdId, entry] of this.processedCommands.entries()) {
      if (now - entry.timestamp > 60000) {
        this.processedCommands.delete(cmdId);
      }
    }
  }

  private checkIdempotency<T>(commandId: string): T | null {
    const existing = this.processedCommands.get(commandId);
    if (existing && Date.now() - existing.timestamp <= 60000) {
      return existing.result as T;
    }
    return null;
  }

  private recordIdempotency(commandId: string, result: unknown): void {
    this.processedCommands.set(commandId, { timestamp: Date.now(), result });
  }

  /**
   * One-Click Market Entry:
   * 1. Validates risk & deduplicates commandId.
   * 2. Calculates marketable LMT Buy price crossing the spread.
   * 3. Places marketable LMT order.
   * 4. Listens for fill or waits for execution.
   * 5. Registers ladder in RatchetLadderEngine & persists to SQLite WAL.
   */
  async enterPosition(params: OneClickEntryParams): Promise<LadderPosition> {
    const cached = this.checkIdempotency<LadderPosition>(params.commandId);
    if (cached) return cached;

    const inFlight = this.inFlightEntries.get(params.commandId);
    if (inFlight) return inFlight;
    if (this.inFlightEntryTokens.has(params.token)) {
      throw new Error(`An entry order is already in flight for ${params.token}.`);
    }

    const entry = this.executeEntry(params);
    this.inFlightEntries.set(params.commandId, entry);
    this.inFlightEntryTokens.add(params.token);
    try {
      return await entry;
    } finally {
      this.inFlightEntryTokens.delete(params.token);
      if (this.inFlightEntries.get(params.commandId) === entry) {
        this.inFlightEntries.delete(params.commandId);
      }
    }
  }

  private async executeEntry(params: OneClickEntryParams): Promise<LadderPosition> {
    const side = params.side ?? 'BUY';
    // 1. Risk check
    const currentPosition = this.engine.getPosition(params.token);
    if (currentPosition?.status === 'OPEN') {
      throw new Error(`An open position already exists for ${params.symbol}; close it before entering again.`);
    }
    this.riskGuard.validateOrder({
      symbol: params.symbol,
      quantity: params.quantity,
      side,
      currentOpenQty: currentPosition ? currentPosition.quantity : 0,
    });

    // 2. Price calculation (spread crossing)
    const limitPricePaise = MarketableLimitPricer.calculatePrice(
      side,
      params.ltpPaise,
      side === 'BUY' ? params.bestAskPaise : params.bestBidPaise,
      params.pricingBuffer
    );

    // 3. Place Marketable Limit Order
    const placeResult = await this.broker.placeLimitOrder({
      commandId: params.commandId,
      token: params.token,
      symbol: params.symbol,
      exchange: params.exchange,
      side,
      orderType: 'LMT',
      quantity: params.quantity,
      pricePaise: limitPricePaise,
      product: params.product,
      priority: 'NORMAL',
    });

    await this.stateStore.recordOrderAudit({
      commandId: params.commandId,
      token: params.token,
      symbol: params.symbol,
      action: 'PLACE_ENTRY',
      orderId: placeResult.orderId,
      pricePaise: limitPricePaise,
      status: placeResult.status,
      timestamp: Date.now(),
    });

    // Wait for fill or fallback to placed price if already filled
    let fillPricePaise = placeResult.filledPricePaise ?? limitPricePaise;
    if (placeResult.status !== 'FILLED') {
      fillPricePaise = await this.waitForFill(placeResult.orderId, limitPricePaise, 2000);
    }

    // 4. Setup initial ladder position
    const nextMilestone = params.nextMilestonePaise ??
      fillPricePaise + (side === 'BUY' ? 1 : -1) * params.stepSizePaise;
    const position: LadderPosition = {
      token: params.token,
      symbol: params.symbol,
      exchange: params.exchange,
      side,
      product: params.product ?? 'I',
      quantity: params.quantity,
      entryPricePaise: fillPricePaise,
      nextMilestonePaise: nextMilestone,
      stepSizePaise: params.stepSizePaise,
      breakoutBufferPaise: params.breakoutBufferPaise,
      slippageBufferPaise: params.slippageBufferPaise,
      activeSlOrderId: null,
      activeSlTriggerPaise: null,
      activeSlLimitPaise: null,
      isUpdating: false,
      status: 'OPEN',
      isPaused: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 5. Place initial SL-LMT if configured
    if (params.initialSlTriggerPaise && params.initialSlLimitPaise) {
      const slResult = await this.broker.placeSlLimitOrder({
        commandId: `${params.commandId}_SL`,
        token: params.token,
        symbol: params.symbol,
        exchange: params.exchange,
        side: side === 'BUY' ? 'SELL' : 'BUY',
        orderType: 'SL-LMT',
        quantity: params.quantity,
        pricePaise: params.initialSlLimitPaise,
        triggerPricePaise: params.initialSlTriggerPaise,
        product: params.product,
        priority: 'NORMAL',
      });
      position.activeSlOrderId = slResult.orderId;
      position.activeSlTriggerPaise = params.initialSlTriggerPaise;
      position.activeSlLimitPaise = params.initialSlLimitPaise;
    }

    // Register with engine & SQLite
    this.engine.registerPosition(position);
    await this.stateStore.savePosition(position);
    await this.feed.subscribe([`${params.exchange}|${params.token}`]);

    this.recordIdempotency(params.commandId, position);
    return position;
  }

  private async waitForFill(orderId: string, fallbackPricePaise: number, timeoutMs = 2000): Promise<number> {
    return new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFills.delete(orderId);
        resolve(fallbackPricePaise);
      }, timeoutMs);

      this.pendingFills.set(orderId, (update) => {
        if (update.status === 'COMPLETE' || update.status === 'FILLED') {
          clearTimeout(timer);
          this.pendingFills.delete(orderId);
          const filledPaise = update.avgprc ? toPaise(update.avgprc) : fallbackPricePaise;
          resolve(filledPaise);
        }
      });
    });
  }

  /**
   * Exits a single position: cancels active SL-LMT and places marketable LMT exit order.
   */
  async exitPosition(commandId: string, token: string): Promise<ExitResult> {
    const cached = this.checkIdempotency<ExitResult>(commandId);
    if (cached) return cached;

    const pos = this.engine.getPosition(token);
    if (!pos) {
      throw new Error(`Position for token ${token} not found`);
    }

    // Cancel active SL if present
    if (pos.activeSlOrderId) {
      await this.broker.cancelOrder({
        commandId: `${commandId}_CANCEL`,
        orderId: pos.activeSlOrderId,
        token: pos.token,
        priority: 'HIGH',
      }).catch(() => {});
    }

    // Exit via BrokerPort
    const exitRes = await this.broker.exitPosition(token, commandId);

    // Close position
    pos.status = 'CLOSED';
    this.engine.removePosition(token);
    await this.stateStore.updatePositionStatus(token, 'CLOSED');

    const exitPrice = exitRes.filledPricePaise ?? pos.entryPricePaise;
    const pnlPaise = (exitPrice - pos.entryPricePaise) * pos.quantity * (pos.side === 'BUY' ? 1 : -1);
    this.riskGuard.recordRealizedPnl(pnlPaise);

    await this.stateStore.recordClosedTrade({
      token: pos.token,
      tradingSymbol: pos.symbol,
      qty: pos.quantity,
      entryPaise: pos.entryPricePaise,
      exitPaise: exitPrice,
      realizedPnlPaise: pnlPaise,
      closedAt: Date.now(),
    });

    const result: ExitResult = {
      token,
      commandId,
      orderId: exitRes.orderId,
      status: 'FILLED',
    };
    this.recordIdempotency(commandId, result);
    return result;
  }

  /**
   * Panic Exit All: Cancels all open SL-LMT orders and submits marketable LMT exit orders.
   */
  async panicExitAll(commandId: string): Promise<void> {
    const cached = this.checkIdempotency<void>(commandId);
    if (cached) return;

    // High priority: preempts regular rate limit queue
    await this.broker.exitAllPositions(commandId);

    const active = this.engine.getAllPositions();
    for (const pos of active) {
      pos.status = 'CLOSED';
      this.engine.removePosition(pos.token);
      await this.stateStore.updatePositionStatus(pos.token, 'CLOSED').catch(() => {});
    }

    this.recordIdempotency(commandId, true);
  }
}
