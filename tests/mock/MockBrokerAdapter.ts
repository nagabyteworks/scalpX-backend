import type { BrokerPort } from '../../src/domain/ports/BrokerPort.js';
import type {
  PlaceOrderIntent,
  ModifyOrderIntent,
  CancelOrderIntent,
  OrderResult,
  OrderStatus,
} from '../../src/domain/models/OrderIntent.js';
import type { Tick } from '../../src/domain/models/Tick.js';
import type {
  FlattradeOrderBookItem,
  FlattradePosition,
  FlattradeQuote,
} from '../../src/adapters/broker/FlattradeProtocol.js';
import { fromPaise } from '../../src/domain/models/Money.js';

export interface PaperOrder {
  orderId: string;
  commandId: string;
  token: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  orderType: 'LMT' | 'SL-LMT';
  quantity: number;
  pricePaise: number;
  triggerPricePaise?: number;
  status: OrderStatus;
  filledPricePaise?: number;
  createdAt: number;
  updatedAt: number;
}

export type OrderFilledListener = (order: PaperOrder) => void;

/**
 * MockBrokerAdapter
 *
 * Simulates strict NSE exchange rules:
 * 1. Rejects Sell SL-LMT if triggerPrice >= currentLtp (trigger must be strictly below LTP).
 * 2. Rejects Sell SL-LMT if price > triggerPrice (limit price must be <= trigger price).
 * 3. Rejects modifications on completed/not-found orders.
 * 4. Fills Sell SL-LMT when tick hits <= triggerPrice and >= price.
 * 5. Leaves SL open if price gaps straight below limit price (flash crash gap-down unfilled limit).
 */
export class MockBrokerAdapter implements BrokerPort {
  private readonly orders = new Map<string, PaperOrder>();
  private readonly currentLtpMap = new Map<string, number>();
  private orderSeq = 0;
  private simulatedLatencyMs = 0;
  private sessionToken: string | null = null;

  setSessionToken(token: string): void {
    this.sessionToken = token;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  // Audit counters for test verification
  private placeCount = 0;
  private modifyCount = 0;
  private cancelCount = 0;
  private onOrderFilledListener?: OrderFilledListener;

  setSimulatedLatency(ms: number): void {
    this.simulatedLatencyMs = ms;
  }

  setOnOrderFilled(listener: OrderFilledListener): void {
    this.onOrderFilledListener = listener;
  }

  getPlaceCallCount(): number {
    return this.placeCount;
  }

  getModifyCallCount(): number {
    return this.modifyCount;
  }

  getCancelCallCount(): number {
    return this.cancelCount;
  }

  getOrder(orderId: string): PaperOrder | undefined {
    return this.orders.get(orderId);
  }

  getAllOrders(): PaperOrder[] {
    return Array.from(this.orders.values());
  }

  private async applyLatency(): Promise<void> {
    if (this.simulatedLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedLatencyMs));
    }
  }

  /**
   * Updates simulated market price and triggers execution matching against active SL orders.
   */
  processTick(tick: Tick): void {
    this.currentLtpMap.set(tick.token, tick.ltpPaise);

    for (const order of this.orders.values()) {
      if (order.token === tick.token && order.status === 'OPEN' && order.orderType === 'SL-LMT') {
        if (order.side === 'SELL' && order.triggerPricePaise !== undefined) {
          // Check if tick hits trigger price
          if (tick.ltpPaise <= order.triggerPricePaise) {
            // Check if tick is at or above the limit price
            if (tick.ltpPaise >= order.pricePaise) {
              order.status = 'FILLED';
              order.filledPricePaise = tick.ltpPaise;
              order.updatedAt = Date.now();
              this.onOrderFilledListener?.(order);
            } else {
              // Gap-down straight below limit price: Order stays OPEN (NSE unfilled limit!)
            }
          }
        }
      }
    }
  }

  async placeLimitOrder(intent: PlaceOrderIntent): Promise<OrderResult> {
    await this.applyLatency();
    this.placeCount++;

    const orderId = `LMT_${++this.orderSeq}`;
    const order: PaperOrder = {
      orderId,
      commandId: intent.commandId,
      token: intent.token,
      symbol: intent.symbol,
      exchange: intent.exchange,
      side: intent.side,
      orderType: 'LMT',
      quantity: intent.quantity,
      pricePaise: intent.pricePaise,
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.orders.set(orderId, order);
    return { orderId, status: 'OPEN' };
  }

  async placeSlLimitOrder(intent: PlaceOrderIntent): Promise<OrderResult> {
    await this.applyLatency();
    this.placeCount++;

    if (intent.orderType !== 'SL-LMT') {
      throw new Error(`Invalid order type for placeSlLimitOrder: ${intent.orderType}`);
    }

    if (intent.triggerPricePaise === undefined) {
      throw new Error('triggerPricePaise is required for SL-LMT order');
    }

    if (intent.side === 'SELL') {
      const currentLtp = this.currentLtpMap.get(intent.token);
      if (currentLtp !== undefined && intent.triggerPricePaise >= currentLtp) {
        throw new Error(
          `NSE Rejection: Sell SL-LMT trigger price (${intent.triggerPricePaise}) must be strictly less than current LTP (${currentLtp})`
        );
      }

      if (intent.pricePaise > intent.triggerPricePaise) {
        throw new Error(
          `NSE Rejection: Sell SL-LMT limit price (${intent.pricePaise}) cannot be greater than trigger price (${intent.triggerPricePaise})`
        );
      }
    }

    const orderId = `SL_${++this.orderSeq}`;
    const order: PaperOrder = {
      orderId,
      commandId: intent.commandId,
      token: intent.token,
      symbol: intent.symbol,
      exchange: intent.exchange,
      side: intent.side,
      orderType: 'SL-LMT',
      quantity: intent.quantity,
      pricePaise: intent.pricePaise,
      triggerPricePaise: intent.triggerPricePaise,
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.orders.set(orderId, order);
    return { orderId, status: 'OPEN' };
  }

  async modifySlLimitOrder(intent: ModifyOrderIntent): Promise<OrderResult> {
    await this.applyLatency();
    this.modifyCount++;

    const order = this.orders.get(intent.orderId);
    if (!order) {
      throw new Error(`Order not found: ${intent.orderId}`);
    }

    if (order.status === 'FILLED' || order.status === 'CANCELLED') {
      throw new Error(`Order already completed: ${intent.orderId}`);
    }

    const newTrigger = intent.newTriggerPricePaise ?? order.triggerPricePaise;
    if (newTrigger === undefined) {
      throw new Error('triggerPricePaise is required for SL-LMT order');
    }

    if (order.side === 'SELL') {
      const currentLtp = this.currentLtpMap.get(intent.token);
      if (currentLtp !== undefined && newTrigger >= currentLtp) {
        throw new Error(
          `NSE Rejection: Sell SL-LMT trigger price (${newTrigger}) must be strictly less than current LTP (${currentLtp})`
        );
      }

      if (intent.newPricePaise > newTrigger) {
        throw new Error(
          `NSE Rejection: Sell SL-LMT limit price (${intent.newPricePaise}) cannot be greater than trigger price (${newTrigger})`
        );
      }
    }

    order.pricePaise = intent.newPricePaise;
    order.triggerPricePaise = newTrigger;
    if (intent.newQuantity) {
      order.quantity = intent.newQuantity;
    }
    order.updatedAt = Date.now();

    return { orderId: order.orderId, status: 'OPEN' };
  }

  async cancelOrder(intent: CancelOrderIntent): Promise<void> {
    await this.applyLatency();
    this.cancelCount++;

    const order = this.orders.get(intent.orderId);
    if (!order) {
      throw new Error(`Order not found: ${intent.orderId}`);
    }
    if (order.status === 'OPEN') {
      order.status = 'CANCELLED';
      order.updatedAt = Date.now();
    }
  }

  async exitPosition(token: string, _commandId: string): Promise<OrderResult> {
    await this.applyLatency();
    for (const order of this.orders.values()) {
      if (order.token === token && order.status === 'OPEN') {
        order.status = 'CANCELLED';
        order.updatedAt = Date.now();
      }
    }
    return { orderId: `EXIT_${token}`, status: 'FILLED' };
  }

  async exitAllPositions(_commandId: string): Promise<void> {
    await this.applyLatency();
    for (const order of this.orders.values()) {
      if (order.status === 'OPEN') {
        order.status = 'CANCELLED';
        order.updatedAt = Date.now();
      }
    }
  }

  async getOrderBook(): Promise<FlattradeOrderBookItem[]> {
    await this.applyLatency();
    return Array.from(this.orders.values()).map((o) => ({
      norenordno: o.orderId,
      exch: o.exchange,
      tsym: o.symbol,
      token: o.token,
      status: o.status === 'OPEN' ? (o.orderType === 'SL-LMT' ? 'TRIGGER_PENDING' : 'OPEN') : o.status,
      prctyp: o.orderType,
      trantype: o.side === 'BUY' ? 'B' : 'S',
      qty: String(o.quantity),
      prc: fromPaise(o.pricePaise),
      trgprc: o.triggerPricePaise ? fromPaise(o.triggerPricePaise) : undefined,
      avgprc: o.filledPricePaise ? fromPaise(o.filledPricePaise) : undefined,
    }));
  }

  async getPositionBook(): Promise<FlattradePosition[]> {
    await this.applyLatency();
    const tokenQtyMap = new Map<string, { symbol: string; exchange: string; netqty: number }>();
    for (const order of this.orders.values()) {
      if (order.status === 'FILLED') {
        const existing = tokenQtyMap.get(order.token) ?? {
          symbol: order.symbol,
          exchange: order.exchange,
          netqty: 0,
        };
        const delta = order.side === 'BUY' ? order.quantity : -order.quantity;
        existing.netqty += delta;
        tokenQtyMap.set(order.token, existing);
      }
    }

    return Array.from(tokenQtyMap.entries()).map(([token, val]) => ({
      stat: 'Ok',
      token,
      tsym: val.symbol,
      exch: val.exchange,
      netqty: String(val.netqty),
    }));
  }

  async getQuotes(exch: string, token: string): Promise<FlattradeQuote> {
    await this.applyLatency();
    const ltp = this.currentLtpMap.get(token);
    if (ltp === undefined) return { stat: 'Not_Ok', token, lp: '0' };
    return {
      stat: 'Ok',
      token,
      lp: fromPaise(ltp),
      bp1: fromPaise(ltp),
      sp1: fromPaise(ltp),
    };
  }

  async getOptionChain(exch: string, tsym: string, _strprc: string, count = 10): Promise<unknown> {
    await this.applyLatency();
    // Paper mode must not imply real exchange instruments or prices.
    return { symbol: tsym.toUpperCase(), expiry: '', strikes: [], dataSource: 'SIMULATED', simulated: true };
  }
}
