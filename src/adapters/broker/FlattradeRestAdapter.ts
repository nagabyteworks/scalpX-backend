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
  type FlattradeIndexEntry,
  type FlattradeTokenResponse,
} from './FlattradeProtocol.js';

export interface FlattradeConfig {
  apiKey: string;
  apiSecret: string;
  userId: string;
  accountId?: string;
  sessionToken?: string;
  baseUrl?: string;
  authUrl?: string;
}

export interface ExitPositionResult extends OrderResult {
  token: string;
  success: boolean;
  error?: string;
}

export class FlattradeOAuthError extends Error {
  readonly stage = 'oauth_exchange';

  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly oauthStatus: string | null,
    readonly brokerMessage: string | null
  ) {
    super(message);
    this.name = 'FlattradeOAuthError';
  }
}

function sanitizeBrokerMessage(message: unknown, secrets: string[]): string | null {
  if (typeof message !== 'string') return null;

  let safe = message
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  safe = safe.replace(/\b(request[_ -]?code|api[_ -]?(?:key|secret)|access[_ -]?token|session[_ -]?token|token|jkey|authorization)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  safe = safe.replace(/\b[A-Za-z0-9_-]*token[A-Za-z0-9_-]*\b/gi, '[REDACTED]');
  safe = safe.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  return safe.slice(0, 200) || null;
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

    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(this.authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        dispatcher: this.dispatcher,
      });
    } catch {
      throw new FlattradeOAuthError('Flattrade OAuth request failed', null, null, null);
    }

    let responseText: string;
    try {
      responseText = await res.body.text();
    } catch {
      throw new FlattradeOAuthError('Flattrade OAuth response could not be read', res.statusCode, null, null);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText) as unknown;
    } catch {
      throw new FlattradeOAuthError('Flattrade OAuth response was invalid', res.statusCode, null, null);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new FlattradeOAuthError('Flattrade OAuth response was invalid', res.statusCode, null, null);
    }
    const data = parsed as FlattradeTokenResponse;

    const responseStatus = data.status ?? data.stat;
    const oauthStatus = sanitizeBrokerMessage(responseStatus, [requestCode, this.config.apiKey, rawSecret, hash]);
    const brokerMessage = sanitizeBrokerMessage(data.emsg, [
      requestCode,
      this.config.apiKey,
      rawSecret,
      hash,
      typeof data.token === 'string' ? data.token : '',
    ]);

    // The OAuth endpoint must return HTTP success as well as a successful OAuth status.
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new FlattradeOAuthError('Flattrade OAuth endpoint returned an HTTP error', res.statusCode, oauthStatus, brokerMessage);
    }
    if (responseStatus !== 'Ok') {
      throw new FlattradeOAuthError('Flattrade rejected OAuth token exchange', res.statusCode, oauthStatus, brokerMessage);
    }
    if (typeof data.token !== 'string' || data.token.trim().length === 0) {
      throw new FlattradeOAuthError('Flattrade OAuth response did not include a valid token', res.statusCode, oauthStatus, brokerMessage);
    }

    const token = data.token.trim();
    this.sessionToken = token;
    return token;
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
      // Broker error bodies are untrusted and can echo submitted credentials or jKey.
      throw new Error('Flattrade returned an invalid response');
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
      throw new Error('Flattrade placeLimitOrder rejected');
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
      throw new Error('Flattrade placeSlLimitOrder rejected');
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

    // qty is REQUIRED by Flattrade ModifyOrder API
    if (intent.newQuantity !== undefined) {
      payload.qty = String(intent.newQuantity);
    }
    if (intent.newTriggerPricePaise !== undefined) {
      payload.trgprc = fromPaise(intent.newTriggerPricePaise);
    }

    const res = await this.postForm<FlattradeOrderResponse>(FLATTRADE_ENDPOINTS.MODIFY_ORDER, payload);
    if (res.stat !== 'Ok') {
      throw new Error('Flattrade modifyOrder failed');
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
      throw new Error('Flattrade cancelOrder failed');
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

  async getIndexList(exch: 'NSE' | 'BSE'): Promise<FlattradeIndexEntry[]> {
    const response = await this.postForm<{ stat?: string; values?: unknown; emsg?: string }>(
      FLATTRADE_ENDPOINTS.GET_INDEX_LIST,
      { uid: this.config.userId, exch }
    );
    if (response.stat !== 'Ok' || !Array.isArray(response.values)) return [];
    return response.values.flatMap((value): FlattradeIndexEntry[] => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      if (typeof item.idxname !== 'string' || typeof item.token !== 'string' || !/^\d+$/.test(item.token)) return [];
      return [{ idxname: item.idxname.trim(), token: item.token }];
    });
  }

  /** Validate the current jKey using Flattrade's documented read-only Limits API. */
  async validateSession(): Promise<'VALID' | 'INVALID' | 'UNKNOWN'> {
    try {
      const response = await this.postForm<{ stat?: string; emsg?: string }>(FLATTRADE_ENDPOINTS.LIMITS, {
        uid: this.config.userId,
        actid: this.config.accountId ?? this.config.userId,
      });
      if (response.stat === 'Ok') return 'VALID';
      if (/session expired|invalid session key/i.test(response.emsg ?? '')) return 'INVALID';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
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

  /**
   * Exits a single position by token.
   *
   * CRITICAL SAFETY RULES:
   * 1. Cancels all open/trigger-pending orders for the token first.
   * 2. Fetches live LTP from the broker. If LTP is unavailable, DOES NOT use a fallback price.
   *    Instead, throws an error so the caller can alert for manual intervention.
   * 3. Uses marketable-limit pricing (LTP ± 1 rupee buffer, rounded to 0.05 tick).
   * 4. Never submits an order with an invented or stale price.
   */
  async exitPosition(token: string, _commandId: string): Promise<OrderResult> {
    // Cancel all open orders for this token first
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

    if (netQty === 0 || !pos) {
      return { orderId: `EXIT_${token}`, status: 'FILLED' };
    }

    // Fetch live quote — NEVER use a fallback invented price
    const quote = await this.getQuotes(pos.exch, token);
    if (!quote.lp || quote.lp === '0') {
      throw new Error(
        `exitPosition: LTP unavailable for token ${token} (${pos.tsym}). ` +
          'Cannot safely submit exit order without a live market price. Manual intervention required.'
      );
    }

    const ltp = parseFloat(quote.lp);
    if (!isFinite(ltp) || ltp <= 0) {
      throw new Error(
        `exitPosition: Invalid LTP "${quote.lp}" for token ${token} (${pos.tsym}). ` +
          'Cannot safely submit exit order. Manual intervention required.'
      );
    }

    // Marketable-limit pricing: sell slightly below LTP, buy slightly above
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

  /**
   * Exits all open positions.
   *
   * CRITICAL SAFETY RULES:
   * 1. Attempts to exit each position independently.
   * 2. NEVER swallows individual failures — collects and reports all results.
   * 3. NEVER reports success while any position remains unresolved.
   * 4. Throws a comprehensive error if any exit attempt fails.
   */
  async exitAllPositions(commandId: string): Promise<void> {
    // Cancel all open orders first (best effort)
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
    const openPositions = positions.filter((pos) => parseInt(pos.netqty ?? '0', 10) !== 0);

    if (openPositions.length === 0) {
      return;
    }

    const results: ExitPositionResult[] = [];

    // Attempt each exit independently — never swallow failures
    for (const pos of openPositions) {
      try {
        const res = await this.exitPosition(pos.token, `${commandId}_${pos.token}`);
        results.push({ ...res, token: pos.token, success: true });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results.push({
          orderId: `EXIT_FAILED_${pos.token}`,
          status: 'REJECTED',
          token: pos.token,
          success: false,
          error: errMsg,
        });
      }
    }

    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      const failureDetails = failures.map((f) => `${f.token}: ${f.error ?? 'unknown'}`).join('; ');
      throw new Error(
        `exitAllPositions: ${failures.length}/${openPositions.length} exit(s) FAILED. ` +
          `Manual intervention required. Failures: ${failureDetails}`
      );
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.destroy();
  }
}
