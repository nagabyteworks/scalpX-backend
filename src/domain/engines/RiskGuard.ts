import type { OrderPriority, OrderSide } from '../models/OrderIntent.js';

export class RiskViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskViolationError';
  }
}

export interface RiskLimits {
  maxLotsPerOrder: number;
  lotSize: number;
  maxOpenQtyPerSymbol: number;
  maxDailyLossPaise: number;
  rateLimitCapacity?: number; // Default 6 tokens
  refillRatePerSec?: number; // Default 6 tokens/sec
}

interface QueuedTask<T> {
  priority: OrderPriority;
  execute: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class RiskGuard {
  private readonly limits: RiskLimits;
  private realizedPnlPaise = 0;
  private isKilled = false;

  // Token-bucket rate limiter (capped at 6 calls/sec, HIGH priority preempts NORMAL)
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private tokens: number;
  private lastRefillTimestamp: number;

  private readonly highPriorityQueue: QueuedTask<unknown>[] = [];
  private readonly normalPriorityQueue: QueuedTask<unknown>[] = [];
  private processTimer: NodeJS.Timeout | null = null;

  constructor(limits: RiskLimits) {
    this.limits = limits;
    this.capacity = limits.rateLimitCapacity ?? 6;
    this.refillRatePerSec = limits.refillRatePerSec ?? 6;
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  /**
   * Validates risk limits before sending an order.
   * Throws RiskViolationError if any rule is breached.
   */
  validateOrder(params: {
    symbol: string;
    quantity: number;
    side: OrderSide;
    currentOpenQty: number;
  }): void {
    if (this.isKillSwitchTriggered()) {
      throw new RiskViolationError(
        `Daily kill switch triggered. Cumulative daily loss: ${Math.abs(this.realizedPnlPaise)} paise exceeds limit ${this.limits.maxDailyLossPaise} paise.`
      );
    }

    const orderLots = params.quantity / this.limits.lotSize;
    if (orderLots > this.limits.maxLotsPerOrder) {
      throw new RiskViolationError(
        `Order quantity ${params.quantity} (${orderLots} lots) exceeds max lots per order limit of ${this.limits.maxLotsPerOrder} lots.`
      );
    }

    if (params.side === 'BUY') {
      const resultingQty = params.currentOpenQty + params.quantity;
      if (resultingQty > this.limits.maxOpenQtyPerSymbol) {
        throw new RiskViolationError(
          `Resulting quantity ${resultingQty} for ${params.symbol} exceeds max open quantity limit of ${this.limits.maxOpenQtyPerSymbol}.`
        );
      }
    }
  }

  /**
   * Records realized P&L from a closed trade.
   * If cumulative loss reaches or exceeds maxDailyLossPaise, triggers kill switch.
   */
  recordRealizedPnl(pnlPaise: number): void {
    this.realizedPnlPaise += pnlPaise;
    if (this.realizedPnlPaise <= -this.limits.maxDailyLossPaise) {
      this.isKilled = true;
    }
  }

  isKillSwitchTriggered(): boolean {
    return this.isKilled || this.realizedPnlPaise <= -this.limits.maxDailyLossPaise;
  }

  getRealizedPnlPaise(): number {
    return this.realizedPnlPaise;
  }

  triggerKillSwitch(): void {
    this.isKilled = true;
  }

  /**
   * Token bucket rate limiter:
   * Capped at 6 calls/sec. HIGH priority preempts NORMAL priority.
   */
  schedule<T>(priority: OrderPriority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queuedItem: QueuedTask<T> = {
        priority,
        execute: task,
        resolve: resolve as (val: unknown) => void,
        reject,
      };

      if (priority === 'HIGH') {
        this.highPriorityQueue.push(queuedItem as QueuedTask<unknown>);
      } else {
        this.normalPriorityQueue.push(queuedItem as QueuedTask<unknown>);
      }

      this.processQueues();
    });
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTimestamp;
    if (elapsedMs > 0) {
      const addedTokens = (elapsedMs * this.refillRatePerSec) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + addedTokens);
      this.lastRefillTimestamp = now;
    }
  }

  private processQueues(): void {
    this.refillTokens();

    while (this.tokens >= 1) {
      // HIGH priority preempts NORMAL priority
      const nextItem = this.highPriorityQueue.shift() ?? this.normalPriorityQueue.shift();
      if (!nextItem) {
        break;
      }

      this.tokens -= 1;
      // Execute asynchronously
      Promise.resolve()
        .then(() => nextItem.execute())
        .then(
          (result) => nextItem.resolve(result),
          (error) => nextItem.reject(error)
        );
    }

    // If there are still items waiting, schedule next drain based on token refill requirement
    const hasPending = this.highPriorityQueue.length > 0 || this.normalPriorityQueue.length > 0;
    if (hasPending && !this.processTimer) {
      const msUntilNextToken = Math.max(10, Math.ceil((1 - this.tokens) * (1000 / this.refillRatePerSec)));
      this.processTimer = setTimeout(() => {
        this.processTimer = null;
        this.processQueues();
      }, msUntilNextToken);
    }
  }

  getAvailableTokens(): number {
    this.refillTokens();
    return this.tokens;
  }

  getQueueLengths(): { high: number; normal: number } {
    return {
      high: this.highPriorityQueue.length,
      normal: this.normalPriorityQueue.length,
    };
  }

  destroy(): void {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    this.highPriorityQueue.length = 0;
    this.normalPriorityQueue.length = 0;
  }
}
