import fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { SessionAuthenticationError, SessionService, getTodayDateIST } from '../../application/SessionService.js';
import type { OrderManager } from '../../application/OrderManager.js';
import type { ReconcilerService } from '../../application/ReconcilerService.js';
import type { RatchetLadderEngine } from '../../domain/engines/RatchetLadderEngine.js';
import type { SqliteStateStore } from '../persistence/SqliteStateStore.js';
import type { BrokerPort } from '../../domain/ports/BrokerPort.js';
import type { FlattradeWsAdapter } from '../broker/FlattradeWsAdapter.js';
import { FlattradeOAuthError } from '../broker/FlattradeRestAdapter.js';
import type { ClientWsHub, MarketDataSelection } from './ClientWsHub.js';
import { roundDownToTick, roundUpToTick } from '../../domain/models/Money.js';

export interface HttpServerConfig {
  tradingEnabled: boolean;
  flattradeWsFeed?: FlattradeWsAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger?: any;
  /**
   * Allowed CORS origins. Defaults to localhost-only in development.
   * Production must set this to the Android app origin or '' to block all.
   */
  corsOrigin?: string | string[] | boolean;
}

// Zod Schemas for Request Validation
export const OneClickOrderSchema = z.object({
  commandId: z.string().uuid(),
  token: z.string().min(1),
  tradingSymbol: z.string().min(1),
  exchange: z.string().default('NFO'),
  side: z.enum(['BUY', 'SELL']),
  lots: z.number().int().positive(),
  lotSize: z.number().int().positive(),
  product: z.enum(['I', 'M']).default('I'),
  initialSlPoints: z.number().positive().optional(),
  ladderConfig: z
    .object({
      firstMilestonePaise: z.number().int().positive().optional(),
      stepSizePaise: z.number().int().positive(),
      breakoutBufferPaise: z.number().int().positive(),
      slippageBufferPaise: z.number().int().positive(),
    })
    .optional(),
});

export const PatchLadderSchema = z.object({
  nextMilestonePaise: z.number().int().positive().optional(),
  stepSizePaise: z.number().int().positive().optional(),
  breakoutBufferPaise: z.number().int().positive().optional(),
  slippageBufferPaise: z.number().int().positive().optional(),
  paused: z.boolean().optional(),
});

export const ExitPositionSchema = z.object({
  commandId: z.string().uuid(),
  token: z.string().min(1),
});

export const ExitAllSchema = z.object({
  commandId: z.string().uuid(),
});

export const OptionChainQuerySchema = z.object({
  symbol: z.string().default('SENSEX'),
  exchange: z.string().optional(),
  expiry: z.string().optional(),
  strikes: z.coerce.number().int().positive().default(10),
});

function parseContractExpiry(tsym: string): string | null {
  const match = tsym.match(/(\d{1,2})[\s-]*([A-Z]{3})[\s-]*(\d{2}|\d{4})(?=[\s-]*\d*(?:CE|PE|C|P)$)/i);
  if (!match) return null;
  const day = Number(match[1]);
  const monthName = match[2]!.toUpperCase();
  const yearText = match[3]!;
  const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const month = months[monthName];
  if (month === undefined) return null;
  const candidate = new Date(Date.UTC(year, month, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseContractStrike(tsym: string): number | null {
  const match = tsym.match(/(?:\d{1,2}[\s-]*[A-Z]{3}[\s-]*(?:\d{2}|\d{4})[\s-]*)(\d+(?:\.\d+)?)[\s-]*(?:CE|PE|C|P)$/i);
  if (!match) return null;
  const strike = Number(match[1]);
  return Number.isFinite(strike) ? strike : null;
}

function normalizeContractExpiry(value: unknown, tradingSymbol: string): string | null {
  if (typeof value === 'string') {
    const text = value.trim().toUpperCase();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (iso) {
      const parsed = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
      if (parsed.toISOString().slice(0, 10) === text) return text;
    }
    const dateMatch = /^(\d{1,2})[\s-]*([A-Z]{3})[\s-]*(\d{2}|\d{4})$/.exec(text);
    if (dateMatch) {
      const year = dateMatch[3]!.length === 2 ? `20${dateMatch[3]}` : dateMatch[3]!;
      return parseContractExpiry(`${dateMatch[1]}${dateMatch[2]}${year}CE`);
    }
  }
  return parseContractExpiry(tradingSymbol);
}

interface ResolvedOptionContract {
  token: string;
  symbol: string;
  exchange: string;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  lotSize: number | null;
}

export class HttpServer {
  public readonly app: FastifyInstance;
  private readonly config: HttpServerConfig;
  private readonly sessionService: SessionService;
  private readonly orderManager: OrderManager;
  private readonly reconciler: ReconcilerService;
  private readonly engine: RatchetLadderEngine;
  private readonly stateStore: SqliteStateStore;
  private readonly broker: BrokerPort;
  private readonly wsHub?: ClientWsHub;
  private readonly optionContracts = new Map<string, ResolvedOptionContract>();
  private marketDataSelection: MarketDataSelection | null = null;
  private optionChainResolution: { status: 'UNRESOLVED' | 'RESOLVED' | 'FAILED'; reason: string | null } = {
    status: 'UNRESOLVED',
    reason: null,
  };

  constructor(
    config: HttpServerConfig,
    sessionService: SessionService,
    orderManager: OrderManager,
    reconciler: ReconcilerService,
    engine: RatchetLadderEngine,
    stateStore: SqliteStateStore,
    broker: BrokerPort,
    wsHub?: ClientWsHub
  ) {
    this.config = config;
    this.sessionService = sessionService;
    this.orderManager = orderManager;
    this.reconciler = reconciler;
    this.engine = engine;
    this.stateStore = stateStore;
    this.broker = broker;
    this.wsHub = wsHub;

    this.app = fastify({
      logger:
        config.logger !== undefined
          ? config.logger
          : {
              level: 'info',
              redact: {
                paths: [
                  'req.body.otp',
                  'body.otp',
                  'otp',
                  '*.api_secret',
                  '*.Password',
                  '*.jKey',
                  '*.token',
                  'headers.authorization',
                  'req.url',
                  'req.query.code',
                  'req.query.request_code',
                  'query.code',
                  'query.request_code',
                ],
                censor: '[REDACTED]',
              },
            },
    });
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // CORS: restricted to configured origin only (not wildcard in production)
    this.app.register(cors, {
      origin: this.config.corsOrigin ?? false,
      methods: ['GET', 'POST', 'PATCH'],
    });

  }

  /**
   * Checks if order placement is currently permitted.
   * Returns an error message if blocked, or null if permitted.
   *
   * Emergency exits (exitPosition, exitAll) bypass this check deliberately.
   */
  private tradingBlockedReason(): string | null {
    if (!this.config.tradingEnabled) {
      return 'Trading is disabled (TRADING_ENABLED=false). Enable trading only after explicit approval.';
    }
    if (this.reconciler.isAccountStateUncertain) {
      return `Account state uncertain (tokens: [${this.reconciler.uncertainTokens.join(', ')}]). Reconcile before placing new orders.`;
    }
    return null;
  }

  private getInstrumentQuoteState(instrumentId: string | null): 'READY' | 'STALE' | 'WAITING_FOR_TICK' | 'UNRESOLVED' {
    if (!instrumentId) return 'UNRESOLVED';
    if (!this.config.flattradeWsFeed?.isAuthenticatedConnection()) return 'WAITING_FOR_TICK';
    const tick = this.config.flattradeWsFeed?.getLatestTick(instrumentId) ?? null;
    if (!tick) return 'WAITING_FOR_TICK';
    return Date.now() - tick.timestamp <= 3_000 ? 'READY' : 'STALE';
  }

  private async getMarketReadiness(): Promise<{
    instrumentMaster: string;
    spot: string;
    spotResolutionFailure: string | null;
    call: string;
    put: string;
    optionChain: string;
    marketDataReady: boolean;
    selection: MarketDataSelection | null;
  }> {
    let spotInstrumentId: string | null = this.marketDataSelection
      ? `${this.marketDataSelection.spot.exchange}|${this.marketDataSelection.spot.token}`
      : null;
    let spotResolutionFailure: string | null = null;
    if (!spotInstrumentId) {
      try {
        spotInstrumentId = await this.sessionService.getSensexSpotInstrumentId();
      } catch (error) {
        spotInstrumentId = null;
        spotResolutionFailure = error instanceof Error ? error.message : 'Unknown Flattrade index token resolution failure.';
      }
    }

    const spot = this.getInstrumentQuoteState(spotInstrumentId);
    const call = this.marketDataSelection
      ? this.getInstrumentQuoteState(`${this.marketDataSelection.call.exchange}|${this.marketDataSelection.call.token}`)
      : 'UNRESOLVED';
    const put = this.marketDataSelection
      ? this.getInstrumentQuoteState(`${this.marketDataSelection.put.exchange}|${this.marketDataSelection.put.token}`)
      : 'UNRESOLVED';
    const optionChain = this.marketDataSelection
      ? (call === 'READY' && put === 'READY' ? 'READY' : call === 'STALE' || put === 'STALE' ? 'STALE' : 'WAITING_FOR_QUOTES')
      : this.optionChainResolution.status;

    return {
      instrumentMaster: this.optionChainResolution.status === 'RESOLVED'
        ? 'FLATTRADE_GETOPTIONCHAIN'
        : this.optionChainResolution.status,
      spot,
      spotResolutionFailure,
      call,
      put,
      optionChain,
      marketDataReady: spot === 'READY' && call === 'READY' && put === 'READY' &&
        !!this.config.flattradeWsFeed?.isAuthenticatedConnection(),
      selection: this.marketDataSelection,
    };
  }

  private setupRoutes(): void {
    // -------------------------------------------------------------
    // Health Endpoints (Unauthenticated)
    // -------------------------------------------------------------

    /**
     * GET /health/live — Process liveness. Returns 200 as long as the process is running.
     */
    this.app.get('/health/live', async () => {
      return { status: 'ok', uptimeSec: Math.round(process.uptime()) };
    });

    /**
     * GET /health/ready — Readiness. Returns 503 when LIVE mode dependencies are unhealthy.
     */
    this.app.get('/health/ready', async (_req, reply) => {
      const issues: string[] = [];

      const sessionState = await this.sessionService.getSessionState();
      const market = await this.getMarketReadiness();
      if (!sessionState.sessionValid) {
        issues.push(sessionState.sessionValidity === 'UNKNOWN'
          ? 'Broker session validity could not be confirmed'
          : 'No valid broker session (daily login required)');
      }

      // Check feed status
      if (!this.config.flattradeWsFeed) {
        issues.push('Market WebSocket feed is not configured');
      } else {
        const feedState = this.config.flattradeWsFeed.getConnectionState();
        if (feedState !== 'CONNECTED') {
          issues.push(`Market WebSocket feed is ${feedState}`);
        } else if (!this.config.flattradeWsFeed.isAuthenticatedConnection()) {
          issues.push('Market WebSocket broker authentication is not confirmed');
        }
      }

      if (market.instrumentMaster !== 'FLATTRADE_GETOPTIONCHAIN') {
        issues.push(this.optionChainResolution.reason ?? 'Flattrade option contracts have not been resolved.');
      }
      if (market.spot !== 'READY') {
        issues.push(market.spotResolutionFailure ?? `SENSEX spot quote is ${market.spot}.`);
      }
      if (market.selection) {
        if (market.call !== 'READY') issues.push(`ATM CE quote is ${market.call}.`);
        if (market.put !== 'READY') issues.push(`ATM PE quote is ${market.put}.`);
      }
      if (market.optionChain !== 'READY') issues.push(`SENSEX option-chain quote readiness is ${market.optionChain}.`);
      if (!this.config.tradingEnabled) issues.push('Live order execution is disabled by configuration');

      // Check reconciliation state
      if (this.reconciler.isAccountStateUncertain) {
        issues.push(`Account state uncertain for tokens: [${this.reconciler.uncertainTokens.join(', ')}]`);
      }

      if (issues.length > 0) {
        reply.code(503);
        return {
          status: 'not_ready',
          environment: 'LIVE',
          tradingReady: false,
          components: {
            brokerSession: sessionState.sessionValidity,
            websocketTransport: this.config.flattradeWsFeed?.isTransportConnected() ? 'CONNECTED' : 'DISCONNECTED',
            websocketAuthentication: this.config.flattradeWsFeed?.isAuthenticatedConnection() ? 'AUTHENTICATED' : 'UNAUTHENTICATED',
            instrumentMaster: market.instrumentMaster,
            sensexSpot: market.spot,
            callOption: market.call,
            putOption: market.put,
            optionChain: market.optionChain,
            marketDataReady: market.marketDataReady,
            trading: this.config.tradingEnabled ? 'CONFIGURED_BUT_NOT_READY' : 'DISABLED',
          },
          failureReason: this.optionChainResolution.reason,
          issues,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        status: 'ok',
        environment: 'LIVE',
        ready: true,
        tradingReady: false,
        marketDataReady: market.marketDataReady,
        timestamp: new Date().toISOString(),
      };
    });

    /**
     * GET /health — Full health report. Never exposes credentials or tokens.
     */
    this.app.get('/health', async () => {
      const openPositions = this.engine.getAllPositions().filter((p) => p.status === 'OPEN');
      const memoryUsage = process.memoryUsage();
      const sessionState = await this.sessionService.getSessionState();
      const market = await this.getMarketReadiness();

      // A stored token is session state, not proof of broker connectivity.
      const brokerConnected = sessionState.sessionValid && !!this.config.flattradeWsFeed?.isAuthenticatedConnection();

      // Determine actual feed health
      const wsFeedStatus = this.config.flattradeWsFeed?.getConnectionState() ?? 'DISCONNECTED';

      return {
        status: 'ok',
        environment: 'LIVE',
        tradingEnabled: this.config.tradingEnabled,
        brokerConnected,
        sessionTokenPresent: sessionState.sessionTokenPresent,
        sessionValid: sessionState.sessionValid,
        sessionValidity: sessionState.sessionValidity,
        wsFeedStatus,
        wsFeedHealthy: sessionState.sessionValid && market.marketDataReady,
        accountStateUncertain: this.reconciler.isAccountStateUncertain,
        openPositionsCount: openPositions.length,
        memoryRssMb: Math.round(memoryUsage.rss / (1024 * 1024)),
        uptimeSec: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      };
    });

    // -------------------------------------------------------------
    // Unauthenticated Auth Endpoints
    // -------------------------------------------------------------

    // Flattrade OAuth Redirect Callback Handler
    // Accepts request_code (or code) from Flattrade WALL / portal redirect and exchanges for session token.
    const flattradeCallbackHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query = (request.query as any) ?? {};
      const rawCode = query.request_code || query.code;
      const code = typeof rawCode === 'string' ? rawCode.trim() : '';

      if (!code) {
        reply.code(400).send({ error: 'Missing request_code parameter in OAuth callback' });
        return;
      }

      try {
        await this.sessionService.exchangeAndSaveToken(code);

        // Redirect to Android app deep link
        reply.redirect('scalper://auth/success', 302);
      } catch (err: unknown) {
        // Only allow pre-sanitized, non-secret diagnostics from the adapter into logs.
        const stage = err instanceof FlattradeOAuthError
          ? err.stage
          : err instanceof SessionAuthenticationError
            ? err.stage
            : 'authentication_callback';
        const diagnostics = err instanceof FlattradeOAuthError
          ? {
              stage,
              httpStatus: err.httpStatus,
              oauthStatus: err.oauthStatus,
              emsg: err.brokerMessage,
            }
          : { stage };
        this.app.log.error(diagnostics, 'Flattrade authentication stage failed');

        const error = stage === 'oauth_exchange'
          ? 'OAuth exchange failed. Retry authentication.'
          : stage === 'token_persistence'
            ? 'Flattrade token persistence failed. Retry authentication.'
            : stage === 'session_validation'
              ? 'Flattrade session validation failed. Retry authentication.'
              : stage === 'websocket_connection'
                ? 'Flattrade WebSocket connection failed. Retry authentication.'
                : 'Flattrade authentication failed. Retry authentication.';
        reply.code(502).send({ error });
      }
    };

    // Exact Flattrade OAuth Callback endpoint
    this.app.get('/api/auth/flattrade/callback', flattradeCallbackHandler);
    // Legacy alias for backwards compatibility with earlier portal registrations
    this.app.get('/auth/flattrade/callback', flattradeCallbackHandler);

    // -------------------------------------------------------------
    // Authenticated API Endpoints
    // -------------------------------------------------------------

    // The broker's documented authorization step is browser-based.
    this.app.get('/api/auth/login-url', async () => {
      return { loginUrl: this.sessionService.getLoginUrl() };
    });

    this.app.get('/api/app/config', async (request) => {
      const session = await this.sessionService.getSessionState();
      const feed = this.config.flattradeWsFeed;
      const brokerConnected = session.sessionValid && !!feed?.isAuthenticatedConnection();
      return {
        environment: 'LIVE',
        trading: { mode: 'LIVE', enabled: this.config.tradingEnabled, authorized: false },
        broker: { connected: brokerConnected, sessionValidity: session.sessionValidity },
        marketFeed: { connected: !!feed?.isTransportConnected(), status: feed?.getConnectionState() ?? 'DISCONNECTED' },
        features: { optionsTrading: false, positions: true, orderManagement: true },
      };
    });

    // Flattrade Authentication & Session Status Endpoint
    this.app.get('/api/auth/status', async () => {
      const sessionState = await this.sessionService.getSessionState();
      const market = await this.getMarketReadiness();
      const sessionValid = sessionState.sessionValid;
      const wsFeed = this.config.flattradeWsFeed;
      const wsFeedStatus = wsFeed?.getConnectionState() ?? 'DISCONNECTED';
      const wsTransportConnected = !!wsFeed?.isTransportConnected();
      const wsAuthenticated = !!wsFeed?.isAuthenticatedConnection();
      const marketDataReady = sessionValid && wsTransportConnected && wsAuthenticated && market.marketDataReady;
      const brokerConnected = sessionValid && wsAuthenticated;
      const wsFeedHealthy = marketDataReady;

      let status = 'AUTHENTICATION_REQUIRED';
      if (sessionState.sessionValidity === 'INVALID') {
        status = 'AUTHENTICATION_REQUIRED';
      } else if (sessionState.sessionValidity === 'UNKNOWN') {
        status = 'SESSION_VALIDATION_UNAVAILABLE';
      } else if (marketDataReady) {
        status = 'FEED_READY';
      } else if (wsAuthenticated) {
        status = 'AUTHENTICATED';
      } else if (wsFeedStatus === 'RECONNECTING') {
        status = 'WEBSOCKET_CONNECTING';
      } else {
        status = 'WEBSOCKET_DISCONNECTED';
      }

      return {
        status,
        brokerConnected,
        sessionTokenPresent: sessionState.sessionTokenPresent,
        sessionValid,
        sessionValidity: sessionState.sessionValidity,
        wsTransportConnected,
        wsAuthenticated,
        marketDataReady,
        wsFeedHealthy,
        wsFeedStatus,
        accountStateUncertain: this.reconciler.isAccountStateUncertain,
        tradeDate: getTodayDateIST(),
        environment: 'LIVE',
        tradingEnabled: this.config.tradingEnabled,
      };
    });

    this.app.get('/api/market-data/sensex', async (_request, reply) => {
      let instrumentId: string;
      try {
        instrumentId = await this.sessionService.getSensexSpotInstrumentId();
        await this.config.flattradeWsFeed?.subscribe([instrumentId]);
      } catch (error) {
        reply.code(503);
        return {
          index: 'SENSEX',
          exchange: 'BSE',
          status: 'INSTRUMENT_UNAVAILABLE',
          spotLtpPaise: null,
          timestamp: null,
          error: error instanceof Error ? error.message : 'Flattrade SENSEX index resolution failed.',
        };
      }
      const tick = this.config.flattradeWsFeed?.getLatestTick(instrumentId) ?? null;
      const ageMs = tick ? Math.max(0, Date.now() - tick.timestamp) : null;
      const fresh = tick !== null && ageMs !== null && ageMs <= 3_000 &&
        !!this.config.flattradeWsFeed?.isAuthenticatedConnection();
      return {
        index: 'SENSEX',
        exchange: 'BSE',
        token: instrumentId.split('|')[1],
        status: fresh ? 'READY' : tick ? 'STALE' : 'WAITING_FOR_TICK',
        spotLtpPaise: fresh ? tick!.ltpPaise : null,
        timestamp: fresh ? tick!.timestamp : null,
        ageMs,
        marketDataReady: fresh && !!this.config.flattradeWsFeed?.isAuthenticatedConnection(),
        validation: 'TOKEN_FROM_FLATTRADE_GETINDEXLIST',
      };
    });

    this.app.get('/api/market-data/index', async (request, reply) => {
      const symbol = String((request.query as Record<string, unknown>).symbol ?? 'SENSEX').toUpperCase();
      let instrumentId: string;
      try {
        instrumentId = await this.sessionService.getIndexSpotInstrumentId(symbol);
        await this.config.flattradeWsFeed?.subscribe([instrumentId]);
      } catch (error) {
        reply.code(503);
        return {
          index: symbol,
          exchange: symbol === 'SENSEX' ? 'BSE' : 'NSE',
          status: 'INSTRUMENT_UNAVAILABLE',
          spotLtpPaise: null,
          timestamp: null,
          marketDataReady: false,
        };
      }
      const tick = this.config.flattradeWsFeed?.getLatestTick(instrumentId) ?? null;
      const ageMs = tick ? Math.max(0, Date.now() - tick.timestamp) : null;
      const fresh = tick !== null && ageMs !== null && ageMs <= 3_000 &&
        !!this.config.flattradeWsFeed?.isAuthenticatedConnection();
      return {
        index: symbol,
        exchange: symbol === 'SENSEX' ? 'BSE' : 'NSE',
        token: instrumentId.split('|')[1],
        status: fresh ? 'READY' : tick ? 'STALE' : 'WAITING_FOR_TICK',
        spotLtpPaise: fresh ? tick!.ltpPaise : null,
        timestamp: fresh ? tick!.timestamp : null,
        ageMs,
        marketDataReady: fresh && !!this.config.flattradeWsFeed?.isAuthenticatedConnection(),
        validation: 'TOKEN_FROM_FLATTRADE_GETINDEXLIST',
      };
    });

    // Option Chain (Supports SENSEX/BFO and NIFTY/NFO)
    this.app.get('/api/option-chain', async (request, reply) => {
      const parsed = OptionChainQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
        return;
      }

      const symbol = parsed.data.symbol.toUpperCase();
      const exch = parsed.data.exchange ?? (symbol === 'SENSEX' || symbol === 'BANKEX' ? 'BFO' : 'NFO');
      const fail = (statusCode: number, message: string) => {
        this.optionChainResolution = { status: 'FAILED', reason: message };
        this.optionContracts.clear();
        this.marketDataSelection = null;
        this.wsHub?.setMarketDataSelection(null);
        reply.code(statusCode);
        return { error: message };
      };

      let spotInstrumentId: string;
      try {
        spotInstrumentId = await this.sessionService.getIndexSpotInstrumentId(symbol);
        if (!this.config.flattradeWsFeed) {
          return fail(503, 'Flattrade market WebSocket feed is not configured.');
        }
        await this.config.flattradeWsFeed.subscribe([spotInstrumentId]);
      } catch (error) {
        return fail(503, `Flattrade ${symbol} index token resolution failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
      }

      const spotTick = this.config.flattradeWsFeed?.getLatestTick(spotInstrumentId) ?? null;
      const spotAgeMs = spotTick ? Date.now() - spotTick.timestamp : null;
      if (!spotTick || spotAgeMs === null || spotAgeMs > 3000 || !spotTick.ltpPaise) {
        return fail(503, `Fresh ${symbol} spot tick is unavailable${spotTick ? ' (stale)' : ' (waiting for first tick)'}.`);
      }

      const spotRupees = (spotTick.ltpPaise / 100).toFixed(2);
      let rawChain: unknown;
      try {
        if (!this.broker.getOptionChain) {
          return fail(503, 'Broker adapter does not implement Flattrade GetOptionChain.');
        }
        rawChain = await this.broker.getOptionChain(exch, symbol, spotRupees, parsed.data.strikes);
      } catch (error) {
        return fail(502, `Flattrade GetOptionChain request failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
      }
      if (!rawChain || typeof rawChain !== 'object') {
        return fail(503, 'Flattrade GetOptionChain returned no contract response.');
      }
      const chain = rawChain as { stat?: string; values?: unknown[]; emsg?: string };
      if (chain.stat !== 'Ok' || !Array.isArray(chain.values)) {
        return fail(503, `Flattrade GetOptionChain returned ${chain.stat ?? 'an invalid response'}; verify broker session, exchange and underlying symbol.`);
      }

      const contracts: ResolvedOptionContract[] = chain.values.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        const tsym = typeof item.tsym === 'string' ? item.tsym.trim() : '';
        const token = typeof item.token === 'string'
          ? item.token.trim()
          : typeof item.token === 'number' && Number.isSafeInteger(item.token) && item.token > 0
            ? String(item.token)
            : '';
        const expiry = normalizeContractExpiry(item.exd, tsym);
        const parsedStrike = typeof item.strprc === 'string' || typeof item.strprc === 'number'
          ? Number(item.strprc)
          : parseContractStrike(tsym);
          const strike = typeof parsedStrike === 'number' && Number.isFinite(parsedStrike) ? parsedStrike : null;
        const optionCode = typeof item.optt === 'string' ? item.optt.trim().toUpperCase() : '';
        const optionType = optionCode === 'CE' || optionCode === 'C'
          ? 'CE'
          : optionCode === 'PE' || optionCode === 'P'
            ? 'PE'
            : tsym.endsWith('CE') || tsym.endsWith('C')
              ? 'CE'
              : tsym.endsWith('PE') || tsym.endsWith('P')
                ? 'PE'
                : null;
        const lotSizeRaw = typeof item.ls === 'string' || typeof item.ls === 'number' ? Number(item.ls) : NaN;
        const lotSize = Number.isSafeInteger(lotSizeRaw) && lotSizeRaw > 0 ? lotSizeRaw : null;
        if (!tsym || !token || !expiry || strike === null || strike <= 0 || !optionType) return [];
        return [{ symbol: tsym, token, exchange: exch, expiry, strike, optionType, lotSize }];
      });

      if (!contracts.length) {
        return fail(503, 'Flattrade GetOptionChain returned no contracts with valid symbol, token, expiry, strike and option side fields.');
      }
      const today = getTodayDateIST();
      const expiries = [...new Set(contracts.map((contract) => contract.expiry))]
        .filter((expiry) => expiry >= today)
        .sort();
      if (!expiries.length) {
        return fail(503, 'Flattrade GetOptionChain returned no contracts with a valid future expiry.');
      }
      const selectedExpiry = parsed.data.expiry && expiries.includes(parsed.data.expiry)
        ? parsed.data.expiry
        : expiries[0]!;
      const selectedContracts = contracts.filter((contract) => contract.expiry === selectedExpiry);
      const contractsByStrike = new Map<number, { call?: ResolvedOptionContract; put?: ResolvedOptionContract }>();
      for (const contract of selectedContracts) {
        const pair = contractsByStrike.get(contract.strike) ?? {};
        if (contract.optionType === 'CE') pair.call = contract;
        else pair.put = contract;
        contractsByStrike.set(contract.strike, pair);
      }
      const pairedStrikes = [...contractsByStrike.entries()]
        .filter(([, pair]) => pair.call && pair.put)
        .map(([strike]) => strike)
        .sort((a, b) => a - b);
      if (!pairedStrikes.length) {
        return fail(503, `Flattrade returned no complete CE/PE pair for selected expiry ${selectedExpiry}.`);
      }
      const spotRupeesNumber = spotTick.ltpPaise / 100;
      const atmStrike = pairedStrikes.reduce<number>((nearest, strike) =>
        Math.abs(strike - spotRupeesNumber) < Math.abs(nearest - spotRupeesNumber) ? strike : nearest
      , pairedStrikes[0]!);

      const optionIds = selectedContracts.map((contract) => `${exch}|${contract.token}`);
      const oldOptionIds = [...this.optionContracts.keys()];

      if (optionIds.length) {
        await this.config.flattradeWsFeed.subscribe(optionIds);
      }
      const nextContracts = new Map(selectedContracts.map((contract) => [`${exch}|${contract.token}`, contract]));
      const removedIds = oldOptionIds.filter((instrumentId) => !nextContracts.has(instrumentId));
      if (removedIds.length) await this.config.flattradeWsFeed.unsubscribe(removedIds);
      this.optionContracts.clear();
      for (const [instrumentId, contract] of nextContracts) this.optionContracts.set(instrumentId, contract);

      const atmPair = contractsByStrike.get(atmStrike)!;
      const selection: MarketDataSelection = {
        indexSymbol: symbol,
        spot: { token: spotInstrumentId.split('|')[1]!, symbol, exchange: spotInstrumentId.split('|')[0]!, lotSize: null },
        expiry: selectedExpiry,
        atmStrike,
        call: { token: atmPair.call!.token, symbol: atmPair.call!.symbol, exchange: exch, lotSize: atmPair.call!.lotSize },
        put: { token: atmPair.put!.token, symbol: atmPair.put!.symbol, exchange: exch, lotSize: atmPair.put!.lotSize },
        strikes: pairedStrikes.map((strike) => {
          const pair = contractsByStrike.get(strike)!;
          return {
            strikePrice: strike,
            call: { token: pair.call!.token, symbol: pair.call!.symbol, exchange: exch, lotSize: pair.call!.lotSize },
            put: { token: pair.put!.token, symbol: pair.put!.symbol, exchange: exch, lotSize: pair.put!.lotSize },
          };
        }),
      };
      this.marketDataSelection = selection;
      this.optionChainResolution = { status: 'RESOLVED', reason: null };
      this.wsHub?.setMarketDataSelection(selection);

      const strikeDtos = selection.strikes.map((strike) => {
        const freshTick = (contract: { token: string } | null) => {
          if (!contract) return null;
          const tick = this.config.flattradeWsFeed?.getLatestTick(`${exch}|${contract.token}`) ?? null;
          return tick && Date.now() - tick.timestamp <= 3_000 &&
            this.config.flattradeWsFeed?.isAuthenticatedConnection()
            ? { ltpPaise: tick.ltpPaise, timestamp: tick.timestamp }
            : null;
        };
        const ceTick = freshTick(strike.call);
        const peTick = freshTick(strike.put);
        return {
          strikePrice: strike.strikePrice,
          ceToken: strike.call?.token ?? null,
          ceSymbol: strike.call?.symbol ?? null,
          ceLotSize: strike.call?.lotSize ?? null,
          ceLtpPaise: ceTick?.ltpPaise ?? null,
          ceTimestamp: ceTick?.timestamp ?? null,
          peToken: strike.put?.token ?? null,
          peSymbol: strike.put?.symbol ?? null,
          peLotSize: strike.put?.lotSize ?? null,
          peLtpPaise: peTick?.ltpPaise ?? null,
          peTimestamp: peTick?.timestamp ?? null,
        };
      });
      const market = await this.getMarketReadiness();

      return {
        symbol,
        exchange: exch,
        expiry: selectedExpiry,
        expiries,
        strikes: strikeDtos,
        atmStrike,
        dataSource: 'FLATTRADE_GETOPTIONCHAIN',
        marketDataReady: market.marketDataReady,
        validation: 'CONTRACTS_FROM_FLATTRADE_GETOPTIONCHAIN_AND_FRESH_WEBSOCKET_TICKS',
      };
    });

    // One-click order entry requires a contract and price verified by this live broker session.
    this.app.post('/api/orders/one-click', async (request, reply) => {
      const parsed = OneClickOrderSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });

      const blocked = this.tradingBlockedReason();
      if (blocked) return reply.code(403).send({ error: blocked });

      const order = parsed.data;
      const instrumentId = `${order.exchange}|${order.token}`;
      const contract = this.optionContracts.get(instrumentId);
      if (!contract || contract.symbol !== order.tradingSymbol) {
        return reply.code(422).send({ error: 'Selected token, trading symbol and exchange do not match a Flattrade-resolved option contract.' });
      }
      if (contract.lotSize === null || contract.lotSize !== order.lotSize) {
        return reply.code(422).send({ error: 'Requested lot size does not match Flattrade contract metadata.' });
      }
      if (!order.ladderConfig || !order.initialSlPoints) {
        return reply.code(400).send({ error: 'ladderConfig and a positive initialSlPoints are required for a protected entry.' });
      }
      const quantity = order.lots * contract.lotSize;
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        return reply.code(400).send({ error: 'Requested order quantity is outside the supported integer range.' });
      }

      const sessionState = await this.sessionService.getSessionState();
      if (!sessionState.sessionValid || !this.config.flattradeWsFeed?.isAuthenticatedConnection()) {
        return reply.code(503).send({ error: 'Flattrade session or authenticated market-data WebSocket is unavailable.' });
      }
      const tick = this.config.flattradeWsFeed.getLatestTick(instrumentId);
      if (!tick || Date.now() - tick.timestamp > 3_000 || tick.ltpPaise <= 0) {
        return reply.code(503).send({ error: 'Selected option has no fresh Flattrade WebSocket tick; order entry is blocked.' });
      }

      const ladder = order.ladderConfig;
      const slDistancePaise = Math.round(order.initialSlPoints * 100);
      const slTrigger = order.side === 'BUY'
        ? roundDownToTick(tick.ltpPaise - slDistancePaise)
        : roundUpToTick(tick.ltpPaise + slDistancePaise);
      if (slTrigger <= 0) return reply.code(422).send({ error: 'Initial stop-loss distance is invalid for the selected live price.' });
      const slLimit = order.side === 'BUY'
        ? roundDownToTick(slTrigger - ladder.slippageBufferPaise)
        : roundUpToTick(slTrigger + ladder.slippageBufferPaise);
      const firstMilestone = ladder.firstMilestonePaise ?? (
        tick.ltpPaise + (order.side === 'BUY' ? 1 : -1) * ladder.stepSizePaise
      );
      if ((order.side === 'BUY' && firstMilestone <= tick.ltpPaise) ||
        (order.side === 'SELL' && firstMilestone >= tick.ltpPaise)) {
        return reply.code(422).send({ error: 'First target must be beyond the live price in the selected order direction.' });
      }

      try {
        const position = await this.orderManager.enterPosition({
          commandId: order.commandId,
          token: contract.token,
          symbol: contract.symbol,
          exchange: contract.exchange,
          side: order.side,
          product: order.product,
          quantity,
          ltpPaise: tick.ltpPaise,
          bestAskPaise: tick.bestAskPaise,
          bestBidPaise: tick.bestBidPaise,
          stepSizePaise: ladder.stepSizePaise,
          breakoutBufferPaise: ladder.breakoutBufferPaise,
          slippageBufferPaise: ladder.slippageBufferPaise,
          nextMilestonePaise: firstMilestone,
          initialSlTriggerPaise: slTrigger,
          initialSlLimitPaise: slLimit,
        });
        return position;
      } catch (error) {
        return reply.code(422).send({ error: error instanceof Error ? error.message : 'Order entry failed.' });
      }
    });

    // Live Edit Ladder Milestone & Buffers
    this.app.patch('/api/ladders/:token', async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { token } = request.params as any;
      const parsed = PatchLadderSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
        return;
      }

      try {
        this.engine.updateLadderConfig(token, parsed.data);
        const updated = this.engine.getPosition(token);
        return updated;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        reply.code(404).send({ error: errMsg });
      }
    });

    // Exit Position — always permitted regardless of TRADING_ENABLED (emergency exit)
    this.app.post('/api/orders/exit-position', async (request, reply) => {
      const parsed = ExitPositionSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
        return;
      }

      try {
        const res = await this.orderManager.exitPosition(parsed.data.commandId, parsed.data.token);
        return { success: true, ...res };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        reply.code(422).send({ error: errMsg });
      }
    });

    // Panic Exit All — always permitted regardless of TRADING_ENABLED (emergency exit)
    this.app.post('/api/orders/exit-all', async (request, reply) => {
      const parsed = ExitAllSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
        return;
      }

      try {
        await this.orderManager.panicExitAll(parsed.data.commandId);
        return { success: true, message: 'Panic exit executed for all open positions' };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Even partial failures are reported — never swallow
        reply.code(207).send({ success: false, error: errMsg });
      }
    });

    // Today Closed Trades & P&L Summary
    this.app.get('/api/trades/today', async () => {
      // In SQLite WAL
      const activePositions = this.engine.getAllPositions().filter((p) => p.status === 'OPEN');
      return {
        activePositions,
        openPositionsCount: activePositions.length,
        timestamp: Date.now(),
      };
    });

    // OpenAPI Swagger JSON specification
    this.app.get('/docs/swagger.json', async (_req, reply) => {
      const candidates = [
        path.resolve(process.cwd(), 'docs/swagger.json'),
        path.resolve(process.cwd(), 'swagger.json'),
        path.resolve(__dirname, '../../../docs/swagger.json'),
        path.resolve(__dirname, '../../../swagger.json'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return reply.header('Content-Type', 'application/json').send(fs.readFileSync(p, 'utf8'));
        }
      }
      reply.code(404).send({ error: 'Swagger specification not found' });
    });
  }

  async listen(port: number, host = '127.0.0.1'): Promise<string> {
    return this.app.listen({ port, host });
  }

  async close(): Promise<void> {
    await this.app.close();
  }
}
