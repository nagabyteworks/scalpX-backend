import fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from 'jsonwebtoken';
import { matchingTotpStep } from '../../application/Totp.js';
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
import type { ClientWsHub } from './ClientWsHub.js';

export interface HttpServerConfig {
  jwtSecret: string;
  tradingEnabled: boolean;
  flattradeWsFeed?: FlattradeWsAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger?: any;
  /**
   * Allowed CORS origins. Defaults to localhost-only in development.
   * Production must set this to the Android app origin or '' to block all.
   */
  corsOrigin?: string | string[] | boolean;
  /**
   * Backend-only TOTP secret used to authenticate the Android owner.
   */
  deviceTotpSecret?: string;
}

export const TotpAuthenticationSchema = z.object({
  totp: z.string().regex(/^\d{6}$/),
});

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
  private readonly totpAuthFailures = new Map<string, { count: number; windowEndsAt: number }>();

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
                  'req.body.totp',
                  'body.totp',
                  'totp',
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

    // Authentication hook for all /api/* routes
    this.app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.url.split('?')[0] ?? '';

      // Authentication and broker OAuth callback routes are public.
      if (
        !url.startsWith('/api/') ||
        url === '/api/auth/daily-login' ||
        url === '/api/auth/provision-device' ||
        url === '/api/auth/revoke-device' ||
        url === '/api/auth/device/authenticate' ||
        url === '/api/auth/flattrade/callback'
      ) {
        return;
      }

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Missing or malformed Authorization header' });
        return;
      }

      const token = authHeader.substring(7);
      try {
        const decoded = jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'] }) as {
          sub?: string;
          role?: string;
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (request as any).user = decoded;
      } catch {
        reply.code(401).send({ error: 'Invalid or expired JWT token' });
        return;
      }
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
        } else if (!this.config.flattradeWsFeed.isMarketDataReady()) {
          issues.push('Market WebSocket subscriptions have not produced fresh ticks');
        }
      }

      // No official BFO instrument-master URL/schema has been verified yet.
      // Keep all option and order readiness false until validated contracts and
      // independently fresh spot/CE/PE quotes are available.
      issues.push('Authoritative BFO instrument master is unavailable');
      issues.push('SENSEX spot, CE, and PE quote readiness is unavailable');
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
            instrumentMaster: 'UNAVAILABLE',
            sensexSpot: 'UNAVAILABLE',
            callOption: 'UNAVAILABLE',
            putOption: 'UNAVAILABLE',
            optionChain: 'UNAVAILABLE',
            trading: this.config.tradingEnabled ? 'CONFIGURED_BUT_NOT_READY' : 'DISABLED',
          },
          issues,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        status: 'ok',
        environment: 'LIVE',
        ready: true,
        tradingReady: false,
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
        wsFeedHealthy: sessionState.sessionValid && !!this.config.flattradeWsFeed?.isMarketDataReady(),
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
    // TOTP authentication endpoint

    this.app.post('/api/auth/provision-device', async (_request, reply) => {
      reply.code(404).send({ error: 'Not found' });
    });
    this.app.post('/api/auth/revoke-device', async (_request, reply) => {
      reply.code(404).send({ error: 'Not found' });
    });
    this.app.post('/api/auth/device/authenticate', async (_request, reply) => {
      reply.code(404).send({ error: 'Not found' });
    });
    // -------------------------------------------------------------

    this.app.post('/api/auth/daily-login', async (request, reply) => {
      const parsed = TotpAuthenticationSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Provide a six-digit TOTP code.' });
        return;
      }
      const { totp } = parsed.data;
      const now = Date.now();
      const key = request.ip;
      const previous = this.totpAuthFailures.get(key);
      if (previous && previous.windowEndsAt > now && previous.count >= 5) {
        reply.code(429).send({ error: 'Too many authentication attempts. Wait five minutes and try again.' });
        return;
      }
      if (!this.config.deviceTotpSecret) {
        reply.code(503).send({ error: 'Device TOTP authentication is not configured on the backend.' });
        return;
      }
      const step = matchingTotpStep(this.config.deviceTotpSecret, totp, now);
      if (step === null || !(await this.stateStore.consumeTotpStep(step))) {
        this.totpAuthFailures.set(key, !previous || previous.windowEndsAt <= now
          ? { count: 1, windowEndsAt: now + 5 * 60_000 }
          : { ...previous, count: previous.count + 1 });
        reply.code(401).send({ error: 'Invalid or already-used TOTP.' });
        return;
      }
      this.totpAuthFailures.delete(key);
      const accessToken = jwt.sign(
        { sub: 'scalpx-owner', role: 'owner' },
        this.config.jwtSecret,
        { algorithm: 'HS256', expiresIn: '15m' }
      );
      return {
        status: 'ok',
        accessToken,
        expiresIn: 900,
      };
    });

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
      const sessionValid = sessionState.sessionValid;
      const wsFeed = this.config.flattradeWsFeed;
      const wsFeedStatus = wsFeed?.getConnectionState() ?? 'DISCONNECTED';
      const wsTransportConnected = !!wsFeed?.isTransportConnected();
      const wsAuthenticated = !!wsFeed?.isAuthenticatedConnection();
      const marketDataReady = sessionValid && wsTransportConnected && wsAuthenticated && !!wsFeed?.isMarketDataReady();
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
      } catch {
        reply.code(503);
        return { index: 'SENSEX', exchange: 'BSE', status: 'INSTRUMENT_UNAVAILABLE', spotLtpPaise: null, timestamp: null };
      }
      const tick = this.config.flattradeWsFeed?.getLatestTick(instrumentId) ?? null;
      const ageMs = tick ? Math.max(0, Date.now() - tick.timestamp) : null;
      const fresh = tick !== null && ageMs !== null && ageMs <= 3_000;
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

    // Option Chain (Supports SENSEX/BFO and NIFTY/NFO)
    this.app.get('/api/option-chain', async (request, reply) => {
      const parsed = OptionChainQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
        return;
      }

      const symbol = parsed.data.symbol.toUpperCase();
      const exch = parsed.data.exchange ?? (symbol === 'SENSEX' || symbol === 'BANKEX' ? 'BFO' : 'NFO');

      // Flattrade GetOptionChain requires a tradable option/future symbol and a
      // nonzero underlying midpoint. This service has no instrument-master
      // lookup for the index token, so calling it with bare "SENSEX" and "0"
      // would be an unsupported request and could not establish a fresh ATM.
      reply.code(503).send({ error: `Live ${exch} option chain is unavailable until an authoritative instrument master and fresh quotes are configured.` });
    });

    // 1-Click Order Execution — fail closed while authoritative contracts are unavailable
    this.app.post('/api/orders/one-click', async (request, reply) => {
      const blocked = this.tradingBlockedReason();
      if (blocked) return reply.code(403).send({ error: blocked });
      const parsed = OneClickOrderSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
      return reply.code(503).send({ error: 'Order entry is unavailable until authoritative instrument validation and live quote readiness are implemented.' });
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
