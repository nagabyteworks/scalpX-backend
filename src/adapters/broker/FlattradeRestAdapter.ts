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
  type FlattradeIndexOptionContract,
  type FlattradeDerivativesExchange,
  type FlattradeTokenResponse,
  FLATTRADE_INDEX_CONTRACT_MASTER_URLS,
} from './FlattradeProtocol.js';

const CONTRACT_MASTER_CACHE_MS = 15 * 60 * 1000;

function parseCsvRow(line: string): string[] | null {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === ',' ) {
      fields.push(field);
      field = '';
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else {
      field += character;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

function parseMasterExpiry(value: string): string | null {
  const match = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/i.exec(value.trim());
  if (!match) return null;
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const day = Number(match[1]);
  const month = months[match[2]!.toUpperCase()];
  const year = Number(match[3]);
  if (month === undefined) return null;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseFlattradeIndexOptionMaster(
  csv: string,
  exchange: FlattradeDerivativesExchange
): Map<string, FlattradeIndexOptionContract[]> {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  const headers = lines[0] ? parseCsvRow(lines[0]) : null;
  const requiredHeaders = ['Exchange', 'Token', 'Lotsize', 'Symbol', 'Tradingsymbol', 'Instrument', 'Expiry', 'Strike', 'Optiontype'];
  if (!headers || requiredHeaders.some((header) => !headers.includes(header))) {
    throw new Error('Flattrade index contract master has an invalid header.');
  }
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const grouped = new Map<string, FlattradeIndexOptionContract[]>();
  const seen = new Set<string>();

  for (const line of lines.slice(1)) {
    const fields = parseCsvRow(line);
    if (!fields || fields.length !== headers.length) {
      throw new Error('Flattrade index contract master contains a malformed row.');
    }
    const field = (name: string) => fields[indexes.get(name)!]!.trim();
    if (field('Exchange').toUpperCase() !== exchange || field('Instrument').toUpperCase() !== 'OPTIDX') continue;

    const underlyingSymbol = field('Symbol').toUpperCase();
    const token = field('Token');
    const symbol = field('Tradingsymbol');
    const expiry = parseMasterExpiry(field('Expiry'));
    const strike = Number(field('Strike'));
    const lotSize = Number(field('Lotsize'));
    const optionType = field('Optiontype').toUpperCase();
    if (!underlyingSymbol || !/^[1-9]\d*$/.test(token) || !symbol || !expiry ||
      !Number.isSafeInteger(lotSize) || lotSize <= 0 ||
      !Number.isFinite(strike) || strike <= 0 ||
      (optionType !== 'CE' && optionType !== 'PE')) {
      throw new Error('Flattrade index contract master contains invalid option metadata.');
    }

    const contract: FlattradeIndexOptionContract = {
      exchange,
      underlyingSymbol,
      token,
      symbol,
      expiry,
      strike,
      optionType,
      lotSize,
    };
    const contractKey = `${underlyingSymbol}|${expiry}|${strike}|${optionType}`;
    if (seen.has(contractKey)) {
      throw new Error('Flattrade index contract master contains an ambiguous option contract.');
    }
    seen.add(contractKey);
    const contracts = grouped.get(underlyingSymbol) ?? [];
    contracts.push(contract);
    grouped.set(underlyingSymbol, contracts);
  }

  for (const contracts of grouped.values()) {
    contracts.sort((left, right) =>
      left.expiry.localeCompare(right.expiry) ||
      left.strike - right.strike ||
      left.optionType.localeCompare(right.optionType)
    );
  }
  return grouped;
}

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

export type FlattradeIndexListErrorCode =
  | 'BROKER_SESSION_UNAVAILABLE'
  | 'BROKER_API_FAILURE'
  | 'INVALID_INDEX_RESPONSE';

export interface FlattradeIndexListDiagnostics {
  endpoint: string;
  httpStatus: number | null;
  stat: string | null;
  emsg: string | null;
  sessionTokenPresent: boolean;
  sessionValidation: 'VALID' | 'INVALID' | 'UNKNOWN';
  requestDurationMs: number;
  exchange: 'NSE' | 'BSE';
  failureKind:
    | 'MISSING_SESSION_TOKEN'
    | 'NETWORK'
    | 'RESPONSE_READ'
    | 'INVALID_JSON'
    | 'HTTP_ERROR'
    | 'BROKER_REJECTION'
    | 'INVALID_RESPONSE'
    | null;
}

export class FlattradeContractMasterError extends Error {
  constructor(
    readonly code: 'CONTRACT_MASTER_UNAVAILABLE' | 'INVALID_CONTRACT_MASTER',
    message: string
  ) {
    super(message);
    this.name = 'FlattradeContractMasterError';
  }
}

export class FlattradeIndexListError extends Error {
  constructor(
    readonly code: FlattradeIndexListErrorCode,
    message: string,
    readonly diagnostics: FlattradeIndexListDiagnostics
  ) {
    super(message);
    this.name = 'FlattradeIndexListError';
  }
}

type FlattradeRequestFailureKind = 'MISSING_SESSION_TOKEN' | 'NETWORK' | 'RESPONSE_READ' | 'INVALID_JSON';

class FlattradeRequestError extends Error {
  constructor(
    readonly failureKind: FlattradeRequestFailureKind,
    readonly httpStatus: number | null = null
  ) {
    super('Flattrade request failed.');
    this.name = 'FlattradeRequestError';
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
  safe = safe.replace(/\b(request[_ -]?code|api[_ -]?(?:key|secret)|access[_ -]?token|session[_ -]?token|token|jkey|authorization|totp|otp)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
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
  private readonly contractMasterCache = new Map<
    FlattradeDerivativesExchange,
    { expiresAt: number; contractsBySymbol: Map<string, FlattradeIndexOptionContract[]> }
  >();
  private readonly contractMasterLoads = new Map<
    FlattradeDerivativesExchange,
    Promise<Map<string, FlattradeIndexOptionContract[]>>
  >();

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

  private async postFormWithStatus<T>(
    endpoint: string,
    jData: Record<string, unknown>
  ): Promise<{ httpStatus: number; data: T }> {
    if (!this.sessionToken) {
      throw new FlattradeRequestError('MISSING_SESSION_TOKEN');
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const formBody = `jData=${encodeURIComponent(JSON.stringify(jData))}&jKey=${encodeURIComponent(this.sessionToken)}`;
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody,
        dispatcher: this.dispatcher,
      });
    } catch {
      throw new FlattradeRequestError('NETWORK');
    }

    let responseText: string;
    try {
      responseText = await response.body.text();
    } catch {
      throw new FlattradeRequestError('RESPONSE_READ', response.statusCode);
    }

    try {
      return {
        httpStatus: response.statusCode,
        data: JSON.parse(responseText) as T,
      };
    } catch {
      throw new FlattradeRequestError('INVALID_JSON', response.statusCode);
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
      prd: intent.product ?? 'I',
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
      exch: intent.exchange ?? 'NFO',
      tsym: encodeURIComponent(intent.symbol),
      prctyp: intent.orderType,
      prc: fromPaise(intent.newPricePaise),
      prd: intent.product ?? 'I',
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
    const startedAt = Date.now();
    const sessionTokenPresent = Boolean(this.sessionToken);
    let httpStatus: number | null = null;
    let stat: string | null = null;
    let emsg: string | null = null;
    let requestDurationMs = 0;
    let failureKind: FlattradeIndexListDiagnostics['failureKind'] = null;
    let response: { stat?: unknown; values?: unknown; emsg?: unknown };
    try {
      const result = await this.postFormWithStatus<{ stat?: unknown; values?: unknown; emsg?: unknown }>(
        FLATTRADE_ENDPOINTS.GET_INDEX_LIST,
        { uid: this.config.userId, exch }
      );
      httpStatus = result.httpStatus;
      requestDurationMs = Date.now() - startedAt;
      if (typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)) {
        response = result.data;
        stat = sanitizeBrokerMessage(response.stat, [
          this.config.apiKey,
          this.config.apiSecret,
          this.sessionToken ?? '',
        ]);
        emsg = sanitizeBrokerMessage(response.emsg, [
          this.config.apiKey,
          this.config.apiSecret,
          this.sessionToken ?? '',
        ]);
      } else {
        failureKind = 'INVALID_RESPONSE';
        const sessionValidation = sessionTokenPresent ? await this.validateSession() : 'UNKNOWN';
        const diagnostics = this.getIndexListDiagnostics(
          exch,
          httpStatus,
          stat,
          emsg,
          sessionTokenPresent,
          sessionValidation,
          requestDurationMs,
          failureKind
        );
        const sessionRejected = !sessionTokenPresent || sessionValidation === 'INVALID';
        throw new FlattradeIndexListError(
          sessionRejected ? 'BROKER_SESSION_UNAVAILABLE' : 'INVALID_INDEX_RESPONSE',
          'Flattrade GetIndexList returned an invalid response.',
          diagnostics
        );
      }
    } catch (error) {
      if (error instanceof FlattradeIndexListError) throw error;
      requestDurationMs = Date.now() - startedAt;
      failureKind = error instanceof FlattradeRequestError
        ? error.failureKind
        : 'NETWORK';
      if (error instanceof FlattradeRequestError) httpStatus = error.httpStatus;
      const sessionValidation = sessionTokenPresent ? await this.validateSession() : 'UNKNOWN';
      const diagnostics = this.getIndexListDiagnostics(
        exch,
        httpStatus,
        stat,
        emsg,
        sessionTokenPresent,
        sessionValidation,
        requestDurationMs,
        failureKind
      );
      const sessionUnavailable = !sessionTokenPresent || sessionValidation === 'INVALID';
      throw new FlattradeIndexListError(
        sessionUnavailable ? 'BROKER_SESSION_UNAVAILABLE' : 'BROKER_API_FAILURE',
        sessionUnavailable
          ? 'Flattrade session is unavailable for GetIndexList.'
          : 'Flattrade GetIndexList request failed.',
        diagnostics
      );
    }
    if (httpStatus! < 200 || httpStatus! >= 300 || stat !== 'Ok') {
      failureKind = httpStatus! < 200 || httpStatus! >= 300 ? 'HTTP_ERROR' : 'BROKER_REJECTION';
      const sessionValidation = sessionTokenPresent ? await this.validateSession() : 'UNKNOWN';
      const diagnostics = this.getIndexListDiagnostics(
        exch,
        httpStatus,
        stat,
        emsg,
        sessionTokenPresent,
        sessionValidation,
        requestDurationMs,
        failureKind
      );
      const sessionRejected = !sessionTokenPresent || sessionValidation === 'INVALID';
      throw new FlattradeIndexListError(
        sessionRejected ? 'BROKER_SESSION_UNAVAILABLE' : 'BROKER_API_FAILURE',
        sessionRejected
          ? 'Flattrade session is unavailable for GetIndexList.'
          : 'Flattrade GetIndexList returned an unsuccessful response.',
        diagnostics
      );
    }
    if (!Array.isArray(response.values)) {
      const sessionValidation = sessionTokenPresent ? await this.validateSession() : 'UNKNOWN';
      const sessionRejected = !sessionTokenPresent || sessionValidation === 'INVALID';
      const diagnostics = this.getIndexListDiagnostics(
        exch,
        httpStatus,
        stat,
        emsg,
        sessionTokenPresent,
        sessionValidation,
        requestDurationMs,
        'INVALID_RESPONSE'
      );
      throw new FlattradeIndexListError(
        sessionRejected ? 'BROKER_SESSION_UNAVAILABLE' : 'INVALID_INDEX_RESPONSE',
        'Flattrade GetIndexList returned an invalid values field.',
        diagnostics
      );
    }
    return response.values.flatMap((value): FlattradeIndexEntry[] => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      if (typeof item.idxname !== 'string' || !item.idxname.trim()) return [];
      const rawToken = item.token;
      const token = typeof rawToken === 'string'
        ? (/^\d+$/.test(rawToken.trim()) && /[1-9]/.test(rawToken.trim()) ? rawToken.trim() : null)
        : typeof rawToken === 'number' && Number.isSafeInteger(rawToken) && rawToken > 0
          ? String(rawToken)
          : null;
      const rawExchange = item.exch ?? item.exchange;
      const exchange = rawExchange === undefined
        ? exch
        : typeof rawExchange === 'string'
          ? rawExchange.trim().toUpperCase()
          : '';
      return [{
        idxname: item.idxname.trim().replace(/\s+/g, ' '),
        token,
        exchange,
      }];
    });
  }

  private getIndexListDiagnostics(
    exchange: 'NSE' | 'BSE',
    httpStatus: number | null,
    stat: string | null,
    emsg: string | null,
    sessionTokenPresent: boolean,
    sessionValidation: 'VALID' | 'INVALID' | 'UNKNOWN',
    requestDurationMs: number,
    failureKind: FlattradeIndexListDiagnostics['failureKind']
  ): FlattradeIndexListDiagnostics {
    return {
      endpoint: FLATTRADE_ENDPOINTS.GET_INDEX_LIST,
      httpStatus,
      stat,
      emsg,
      sessionTokenPresent,
      sessionValidation,
      requestDurationMs,
      exchange,
      failureKind,
    };
  }

  /** Validate the current jKey using Flattrade's documented read-only Limits API. */
  async validateSession(): Promise<'VALID' | 'INVALID' | 'UNKNOWN'> {
    try {
      const { httpStatus, data: response } = await this.postFormWithStatus<{ stat?: string; emsg?: string }>(
        FLATTRADE_ENDPOINTS.LIMITS,
        {
          uid: this.config.userId,
          actid: this.config.accountId ?? this.config.userId,
        }
      );
      if (httpStatus < 200 || httpStatus >= 300) return 'UNKNOWN';
      if (response.stat === 'Ok') return 'VALID';
      if (/session expired|invalid session key/i.test(response.emsg ?? '')) return 'INVALID';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  async getIndexOptionContracts(
    exchange: FlattradeDerivativesExchange,
    underlyingSymbol: string
  ): Promise<FlattradeIndexOptionContract[]> {
    const symbol = underlyingSymbol.trim().toUpperCase();
    if (!symbol) throw new Error('An underlying symbol is required to resolve Flattrade option contracts.');
    if (!Object.hasOwn(FLATTRADE_INDEX_CONTRACT_MASTER_URLS, exchange)) {
      throw new FlattradeContractMasterError('INVALID_CONTRACT_MASTER', 'Unsupported Flattrade derivatives exchange.');
    }

    let contractsBySymbol = this.contractMasterCache.get(exchange)?.contractsBySymbol;
    if (!contractsBySymbol || (this.contractMasterCache.get(exchange)?.expiresAt ?? 0) <= Date.now()) {
      let load = this.contractMasterLoads.get(exchange);
      if (!load) {
        load = this.downloadIndexOptionMaster(exchange)
          .then((contracts) => {
            this.contractMasterCache.set(exchange, {
              expiresAt: Date.now() + CONTRACT_MASTER_CACHE_MS,
              contractsBySymbol: contracts,
            });
            return contracts;
          })
          .finally(() => this.contractMasterLoads.delete(exchange));
        this.contractMasterLoads.set(exchange, load);
      }
      contractsBySymbol = await load;
    }
    return [...(contractsBySymbol.get(symbol) ?? [])];
  }

  private async downloadIndexOptionMaster(
    exchange: FlattradeDerivativesExchange
  ): Promise<Map<string, FlattradeIndexOptionContract[]>> {
    let response: Response;
    try {
      response = await fetch(FLATTRADE_INDEX_CONTRACT_MASTER_URLS[exchange], {
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new FlattradeContractMasterError('CONTRACT_MASTER_UNAVAILABLE', 'Flattrade index contract master request failed.');
    }
    if (!response.ok) {
      throw new FlattradeContractMasterError(
        'CONTRACT_MASTER_UNAVAILABLE',
        `Flattrade index contract master returned HTTP ${response.status}.`
      );
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 50_000_000) {
      throw new FlattradeContractMasterError('INVALID_CONTRACT_MASTER', 'Flattrade index contract master exceeds the supported size.');
    }
    let csv: string;
    try {
      csv = await response.text();
    } catch {
      throw new FlattradeContractMasterError(
        'CONTRACT_MASTER_UNAVAILABLE',
        'Flattrade index contract master response could not be read.'
      );
    }
    try {
      return parseFlattradeIndexOptionMaster(csv, exchange);
    } catch {
      throw new FlattradeContractMasterError(
        'INVALID_CONTRACT_MASTER',
        'Flattrade index contract master has an invalid or ambiguous contract response.'
      );
    }
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
