import { createHash } from 'node:crypto';
import { Agent, request } from 'undici';
import type { BrokerPort } from '../../domain/ports/BrokerPort.js';
import type {
  PlaceOrderIntent,
  ModifyOrderIntent,
  CancelOrderIntent,
  OrderResult,
} from '../../domain/models/OrderIntent.js';
import { fromPaise } from '../../domain/models/Money.js';
import {
  FLATTRADE_ENDPOINTS,
  type FlattradeOrderResponse,
  type FlattradePosition,
  type FlattradeOrderBookItem,
  type FlattradeQuote,
  type FlattradeTokenResponse,
} from './FlattradeProtocol.js';
import { PaperBrokerAdapter } from './PaperBrokerAdapter.js';

export interface FlattradeConfig {
  apiKey: string;
  apiSecret: string;
  userId: string;
  accountId?: string;
  sessionToken?: string;
  baseUrl?: string;
  authUrl?: string;
}

export class FlattradeRestAdapter implements BrokerPort {
  private readonly config: FlattradeConfig;
  private readonly baseUrl: string;
  private readonly authUrl: string;
  private readonly dispatcher: Agent;
  private sessionToken: string | null = null;

  constructor(config: FlattradeConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? FLATTRADE_ENDPOINTS.BASE_URL;
    this.authUrl = config.authUrl ?? FLATTRADE_ENDPOINTS.AUTH_TOKEN;
    this.sessionToken = config.sessionToken ?? null;
    this.dispatcher = new Agent({
      keepAliveTimeout: 30000,
      keepAliveMaxTimeout: 60000,
    });
  }

  setSessionToken(token: string): void {
    this.sessionToken = token;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  /**
   * Daily OAuth Token Exchange.
   * POST to auth URL with SHA256(api_key + request_code + raw_api_secret).
   */
  async exchangeOAuthToken(requestCode: string): Promise<string> {
    const rawSecret = this.config.apiSecret;
    const hash = createHash('sha256')
      .update(this.config.apiKey + requestCode + rawSecret)
      .digest('hex');

    const payload = {
      api_key: this.config.apiKey,
      request_code: requestCode,
      api_secret: hash,
    };

    const res = await request(this.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      dispatcher: this.dispatcher,
    });

    const responseText = await res.body.text();
    let data: FlattradeTokenResponse;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`Failed to parse OAuth response: ${responseText}`);
    }

    if (data.stat !== 'Ok' || !data.token) {
      throw new Error(`Flattrade OAuth exchange failed: ${data.emsg ?? 'Unknown error'}`);
    }

    this.sessionToken = data.token;
    return data.token;
  }

  /**
   * Raw POST helper with Flattrade v2 form encoding: jData=<JSON>&jKey=<sessionToken>
   */
  private async postForm<T>(endpoint: string, jData: Record<string, unknown>): Promise<T> {
    if (!this.sessionToken) {
      throw new Error('Flattrade session token not initialized. Run daily OAuth exchange first.');
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const formBody = `jData=${encodeURIComponent(JSON.stringify(jData))}&jKey=${encodeURIComponent(this.sessionToken)}`;

    const res = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
      dispatcher: this.dispatcher,
    });

    const text = await res.body.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Failed to parse response from ${endpoint}: ${text}`);
    }
  }

  async placeLimitOrder(intent: PlaceOrderIntent): Promise<OrderResult> {
    if (intent.orderType !== 'LMT' && intent.orderType !== 'SL-LMT') {
      throw new Error(`Non-negotiable Flattrade constraint: only LMT and SL-LMT allowed. Received ${intent.orderType}`);
    }

    const payload = {
      uid: this.config.userId,
      actid: this.config.accountId ?? this.config.userId,
      exch: intent.exchange,
      tsym: encodeURIComponent(intent.symbol),
      qty: String(intent.quantity),
      prc: fromPaise(intent.pricePaise),
      prd: 'I', // MIS scalping
      trantype: intent.side === 'BUY' ? 'B' : 'S',
      prctyp: 'LMT',
      ret: 'DAY',
      ordersource: 'API',
    };

    const res = await this.postForm<FlattradeOrderResponse>(FLATTRADE_ENDPOINTS.PLACE_ORDER, payload);
    if (res.stat !== 'Ok' || !res.norenordno) {
      throw new Error(`Flattrade placeLimitOrder rejected: ${res.emsg ?? 'Unknown error'}`);
    }

    return {
      orderId: res.norenordno,
      status: 'OPEN',
      message: res.request_time,
    };
  }

  async placeSlLimitOrder(intent: PlaceOrderIntent): Promise<OrderResult> {
    if (intent.orderType !== 'SL-LMT') {
      throw new Error(`Non-negotiable constraint: placeSlLimitOrder strictly requires SL-LMT. Received ${intent.orderType}`);
    }
    if (intent.triggerPricePaise === undefined) {
      throw new Error('triggerPricePaise is required for SL-LMT orders');
    }

    const payload = {
      uid: this.config.userId,
      actid: this.config.accountId ?? this.config.userId,
      exch: intent.exchange,
      tsym: encodeURIComponent(intent.symbol),
      qty: String(intent.quantity),
      prc: fromPaise(intent.pricePaise),
      trgprc: fromPaise(intent.triggerPricePaise),
      prd: 'I',
      trantype: intent.side === 'BUY' ? 'B' : 'S',
      prctyp: 'SL-LMT',
      ret: 'DAY',
      ordersource: 'API',
    };

    const res = await this.postForm<FlattradeOrderResponse>(FLATTRADE_ENDPOINTS.PLACE_ORDER, payload);
    if (res.stat !== 'Ok' || !res.norenordno) {
      throw new Error(`Flattrade placeSlLimitOrder rejected: ${res.emsg ?? 'Unknown error'}`);
    }

    return {
      orderId: res.norenordno,
      status: 'OPEN',
      message: res.request_time,
    };
  }

  async modifySlLimitOrder(intent: ModifyOrderIntent): Promise<OrderResult> {
    if (intent.orderType !== 'SL-LMT' && intent.orderType !== 'LMT') {
      throw new Error(`Non-negotiable constraint: modifySlLimitOrder requires SL-LMT or LMT. Received ${intent.orderType}`);
    }

    const payload: Record<string, unknown> = {
      uid: this.config.userId,
      norenordno: intent.orderId,
      exch: 'NFO',
      tsym: encodeURIComponent(intent.symbol),
      prctyp: intent.orderType,
      prc: fromPaise(intent.newPricePaise),
      ordersource: 'API',
    };

    if (intent.newQuantity !== undefined) {
      payload.qty = String(intent.newQuantity);
    }
    if (intent.newTriggerPricePaise !== undefined) {
      payload.trgprc = fromPaise(intent.newTriggerPricePaise);
    }

    const res = await this.postForm<FlattradeOrderResponse>(FLATTRADE_ENDPOINTS.MODIFY_ORDER, payload);
    if (res.stat !== 'Ok') {
      throw new Error(`Flattrade modifyOrder failed: ${res.emsg ?? 'Unknown error'}`);
    }

    return {
      orderId: intent.orderId,
      status: 'OPEN',
      message: res.request_time,
    };
  }

  async cancelOrder(intent: CancelOrderIntent): Promise<void> {
    const payload = {
      uid: this.config.userId,
      norenordno: intent.orderId,
    };

    const res = await this.postForm<{ stat: string; emsg?: string }>(FLATTRADE_ENDPOINTS.CANCEL_ORDER, payload);
    if (res.stat !== 'Ok') {
      throw new Error(`Flattrade cancelOrder failed: ${res.emsg ?? 'Unknown error'}`);
    }
  }

  async getOrderBook(): Promise<FlattradeOrderBookItem[]> {
    const payload = { uid: this.config.userId };
    const res = await this.postForm<FlattradeOrderBookItem[] | { stat: string; emsg?: string }>(
      FLATTRADE_ENDPOINTS.ORDER_BOOK,
      payload
    );

    if (Array.isArray(res)) {
      return res;
    }
    return [];
  }

  async getPositionBook(): Promise<FlattradePosition[]> {
    const payload = {
      uid: this.config.userId,
      actid: this.config.accountId ?? this.config.userId,
    };
    const res = await this.postForm<FlattradePosition[] | { stat: string; emsg?: string }>(
      FLATTRADE_ENDPOINTS.POSITION_BOOK,
      payload
    );

    if (Array.isArray(res)) {
      return res;
    }
    return [];
  }

  async getQuotes(exch: string, token: string): Promise<FlattradeQuote> {
    const payload = {
      uid: this.config.userId,
      exch,
      token,
    };
    return this.postForm<FlattradeQuote>(FLATTRADE_ENDPOINTS.GET_QUOTES, payload);
  }

  async getOptionChain(exch: string, tsym: string, strprc: string, count: number): Promise<unknown> {
    const payload = {
      uid: this.config.userId,
      exch,
      tsym: encodeURIComponent(tsym),
      strprc,
      cnt: String(count),
    };
    return this.postForm<unknown>(FLATTRADE_ENDPOINTS.GET_OPTION_CHAIN, payload);
  }

  async exitPosition(token: string, _commandId: string): Promise<OrderResult> {
    const orders = await this.getOrderBook();
    const openOrders = orders.filter((o) => o.token === token && (o.status === 'OPEN' || o.status === 'TRIGGER_PENDING'));
    for (const ord of openOrders) {
      await this.cancelOrder({
        commandId: crypto.randomUUID(),
        orderId: ord.norenordno,
        token,
        priority: 'HIGH',
      }).catch(() => {});
    }

    const positions = await this.getPositionBook();
    const pos = positions.find((p) => p.token === token);
    const netQty = parseInt(pos?.netqty ?? '0', 10);
    if (netQty !== 0 && pos) {
      const quote = await this.getQuotes(pos.exch, token);
      const ltp = quote.lp ? parseFloat(quote.lp) : 100;
      const buffer = netQty > 0 ? -1.0 : 1.0;
      const marketablePrice = Math.max(0.05, Math.round((ltp + buffer) * 20) / 20);

      return this.placeLimitOrder({
        commandId: crypto.randomUUID(),
        token,
        symbol: pos.tsym,
        exchange: pos.exch,
        side: netQty > 0 ? 'SELL' : 'BUY',
        orderType: 'LMT',
        quantity: Math.abs(netQty),
        pricePaise: Math.round(marketablePrice * 100),
        priority: 'HIGH',
      });
    }

    return { orderId: `EXIT_${token}`, status: 'FILLED' };
  }

  async exitAllPositions(commandId: string): Promise<void> {
    const orders = await this.getOrderBook();
    const openOrders = orders.filter((o) => o.status === 'OPEN' || o.status === 'TRIGGER_PENDING');
    for (const ord of openOrders) {
      await this.cancelOrder({
        commandId: `${commandId}_${ord.norenordno}`,
        orderId: ord.norenordno,
        token: ord.token ?? '',
        priority: 'HIGH',
      }).catch(() => {});
    }

    const positions = await this.getPositionBook();
    for (const pos of positions) {
      const netQty = parseInt(pos.netqty ?? '0', 10);
      if (netQty !== 0) {
        await this.exitPosition(pos.token, `${commandId}_${pos.token}`).catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.destroy();
  }
}

/**
 * Factory with BROKER_MODE=paper|live environment toggle.
 */
export function createBrokerAdapter(config: Partial<FlattradeConfig> & { mode?: 'paper' | 'live' }): BrokerPort {
  const mode = process.env.BROKER_MODE || config.mode || 'paper';
  if (mode === 'live') {
    return new FlattradeRestAdapter({
      apiKey: config.apiKey ?? '',
      apiSecret: config.apiSecret ?? '',
      userId: config.userId ?? '',
      accountId: config.accountId,
      sessionToken: config.sessionToken,
      baseUrl: config.baseUrl,
      authUrl: config.authUrl,
    });
  }
  return new PaperBrokerAdapter();
}
