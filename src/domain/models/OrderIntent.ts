/**
 * Flattrade API v2 Order Types: Strictly LMT and SL-LMT only.
 * MKT, SL-MKT, CO, and BO are strictly forbidden by architectural rules.
 */
export type AllowedOrderType = 'LMT' | 'SL-LMT';
export type OrderSide = 'BUY' | 'SELL';
export type OrderPriority = 'HIGH' | 'NORMAL';
export type OrderExecutionStatus = 'SUBMITTED' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';
export type OrderStatus = OrderExecutionStatus;

export interface PlaceOrderIntent {
  commandId: string; // UUIDv4 for deduplication
  token: string;
  symbol: string;
  exchange: string;
  side: OrderSide;
  orderType: AllowedOrderType;
  quantity: number;
  pricePaise: number;
  triggerPricePaise?: number; // Required for SL-LMT
  priority?: OrderPriority;
  tag?: string;
}

export interface ModifyOrderIntent {
  commandId: string;
  orderId: string;
  token: string;
  symbol: string;
  orderType: 'SL-LMT' | 'LMT';
  newQuantity?: number;
  newPricePaise: number;
  newTriggerPricePaise?: number; // Required for SL-LMT
  priority?: OrderPriority;
}

export interface CancelOrderIntent {
  commandId: string;
  orderId: string;
  token: string;
  priority?: OrderPriority;
}

export interface OrderResult {
  orderId: string;
  status: OrderExecutionStatus;
  filledPricePaise?: number;
  message?: string;
}
