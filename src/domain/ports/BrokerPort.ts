import type {
  PlaceOrderIntent,
  ModifyOrderIntent,
  CancelOrderIntent,
  OrderResult,
} from '../models/OrderIntent.js';
import type {
  FlattradeOrderBookItem,
  FlattradePosition,
  FlattradeQuote,
} from '../../adapters/broker/FlattradeProtocol.js';

export interface BrokerPort {
  placeLimitOrder(intent: PlaceOrderIntent): Promise<OrderResult>;
  placeSlLimitOrder(intent: PlaceOrderIntent): Promise<OrderResult>;
  modifySlLimitOrder(intent: ModifyOrderIntent): Promise<OrderResult>;
  cancelOrder(intent: CancelOrderIntent): Promise<void>;
  exitPosition(token: string, commandId: string): Promise<OrderResult>;
  exitAllPositions(commandId: string): Promise<void>;
  getOrderBook(): Promise<FlattradeOrderBookItem[]>;
  getPositionBook(): Promise<FlattradePosition[]>;
  getQuotes(exch: string, token: string): Promise<FlattradeQuote>;
  getOptionChain?(exch: string, tsym: string, strprc: string, count: number): Promise<unknown>;
}
