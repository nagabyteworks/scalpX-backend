/**
 * Flattrade API v2 Protocol Constants, Endpoints, and Types.
 * All URLs, field names, and request/response interfaces isolated here.
 */

export const FLATTRADE_ENDPOINTS = {
  AUTH_TOKEN: 'https://authapi.flattrade.in/trade/apitoken',
  BASE_URL: 'https://piconnect.flattrade.in/PiConnectAPI',
  PLACE_ORDER: '/PlaceOrder',
  MODIFY_ORDER: '/ModifyOrder',
  CANCEL_ORDER: '/CancelOrder',
  ORDER_BOOK: '/OrderBook',
  POSITION_BOOK: '/PositionBook',
  LIMITS: '/Limits',
  GET_OPTION_CHAIN: '/GetOptionChain',
  GET_QUOTES: '/GetQuotes',
} as const;

export interface FlattradeTokenRequest {
  api_key: string;
  request_code: string;
  api_secret: string; // sha256(api_key + request_code + raw_api_secret)
}

export interface FlattradeTokenResponse {
  stat: 'Ok' | 'Not_Ok';
  token?: string;
  emsg?: string;
}

export interface FlattradePlaceOrderPayload {
  uid: string;
  actid: string;
  exch: string;
  tsym: string; // Must be encodeURIComponent(tsym)
  qty: string;
  prc: string; // Decimal string e.g. "110.05"
  trgprc?: string; // Decimal string for SL-LMT
  prd: 'I' | 'M'; // "I" MIS or "M" NRML
  trantype: 'B' | 'S'; // "B" BUY or "S" SELL
  prctyp: 'LMT' | 'SL-LMT'; // Strictly LMT or SL-LMT only
  ret: 'DAY';
  ordersource: 'API';
}

export interface FlattradeModifyOrderPayload {
  uid: string;
  norenordno: string;
  exch: string;
  tsym: string; // encodeURIComponent(tsym)
  qty: string;
  prc: string;
  trgprc?: string;
  prctyp: 'LMT' | 'SL-LMT';
  ordersource?: 'API';
}

export interface FlattradeCancelOrderPayload {
  uid: string;
  norenordno: string;
}

export interface FlattradeOrderResponse {
  stat: 'Ok' | 'Not_Ok';
  norenordno?: string;
  emsg?: string;
  request_time?: string;
}

export interface FlattradePosition {
  stat: 'Ok' | 'Not_Ok';
  exch: string;
  tsym: string;
  token: string;
  netqty: string;
  netavgprc?: string;
  upldprc?: string;
  rpnl?: string;
  urmtom?: string;
  prd?: string;
}

export interface FlattradeOrderBookItem {
  norenordno: string;
  exch: string;
  tsym: string;
  token?: string;
  status: 'OPEN' | 'TRIGGER_PENDING' | 'COMPLETE' | 'REJECTED' | 'CANCELED' | string;
  prctyp: 'LMT' | 'SL-LMT' | string;
  trantype: 'B' | 'S';
  qty: string;
  prc: string;
  trgprc?: string;
  avgprc?: string;
  fillshares?: string;
  rejreason?: string;
  ordertag?: string;
}

export interface FlattradeQuote {
  stat: 'Ok' | 'Not_Ok';
  token: string;
  tsym?: string;
  lp?: string; // Last Traded Price
  bp1?: string; // Best Bid 1
  sp1?: string; // Best Ask 1
  c?: string;
  h?: string;
  l?: string;
  o?: string;
  v?: string;
  emsg?: string;
}

export interface OrderUpdateEvent {
  norenordno: string;
  status: 'COMPLETE' | 'REJECTED' | 'CANCELED' | 'OPEN' | 'TRIGGER_PENDING' | string;
  avgprc?: string;
  fillshares?: string;
  rejreason?: string;
  token?: string;
  tsym?: string;
}
