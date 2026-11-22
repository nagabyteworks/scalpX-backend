import fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { SessionService, CooldownActiveError, getTodayDateIST } from '../../application/SessionService.js';
import {
  AuthSessionFailedError,
  InvalidOtpError,
  FallbackRequiredError,
  TokenExchangeError,
} from '../broker/FlattradeAuthClient.js';
import type { OrderManager } from '../../application/OrderManager.js';
import type { ReconcilerService } from '../../application/ReconcilerService.js';
import type { RatchetLadderEngine } from '../../domain/engines/RatchetLadderEngine.js';
import type { SqliteStateStore } from '../persistence/SqliteStateStore.js';
import type { BrokerPort } from '../../domain/ports/BrokerPort.js';
import type { FlattradeWsAdapter } from '../broker/FlattradeWsAdapter.js';
import type { ClientWsHub } from './ClientWsHub.js';

export interface HttpServerConfig {
  jwtSecret: string;
  brokerMode: 'paper' | 'live';
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
   * One-time or master enrollment secret for owner device provisioning.
   */
  enrollmentSecret?: string;
}

export const ProvisionDeviceSchema = z.object({
  enrollmentSecret: z.string().min(1, 'Enrollment secret is required'),
  deviceName: z.string().default('Android Device'),
});

export const DailyOtpSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'OTP must be a 6-digit numeric string'),
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

      // Skip public routes, OAuth callback, and device provisioning endpoint
      if (
        !url.startsWith('/api/') ||
        url === '/api/auth/provision-device' ||
        url === '/api/auth/flattrade/callback'
      ) {
        return;
      }

      const deviceId = request.headers['x-device-id'];
      if (!deviceId || typeof deviceId !== 'string') {
        reply.code(400).send({ error: 'Missing or invalid required X-Device-Id header' });
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
          deviceId?: string;
          sub?: string;
          role?: string;
        };

        // Enforce device-binding: token issued for device A cannot be used from device B
        if (decoded.deviceId && decoded.deviceId !== deviceId) {
          reply.code(403).send({ error: 'Device ID mismatch with token claim' });
          return;
        }

        // Enforce device revocation
        const isRevoked = await this.stateStore.isDeviceRevoked(deviceId);
        if (isRevoked) {
          reply.code(401).send({ error: 'Device authorization has been revoked' });
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (request as any).user = decoded;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (request as any).deviceId = deviceId;
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
      if (this.config.brokerMode === 'paper') {
        return { status: 'ok', brokerMode: 'paper', ready: true };
      }

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
        } else if (!this.config.flattradeWsFeed.isMarketDataReady()) {
          issues.push('Market WebSocket subscriptions have not produced fresh ticks');
        }
      }

      // Check reconciliation state
      if (this.reconciler.isAccountStateUncertain) {
        issues.push(`Account state uncertain for tokens: [${this.reconciler.uncertainTokens.join(', ')}]`);
      }

      if (issues.length > 0) {
        reply.code(503);
        return {
          status: 'not_ready',
          brokerMode: this.config.brokerMode,
          tradingEnabled: this.config.tradingEnabled,
          issues,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        status: 'ok',
        brokerMode: this.config.brokerMode,
        tradingEnabled: this.config.tradingEnabled,
        ready: true,
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
      const brokerConnected = this.config.brokerMode === 'live'
        ? sessionState.sessionValid && !!this.config.flattradeWsFeed?.isAuthenticatedConnection()
        : false;

      // Determine actual feed health
      let wsFeedStatus: string = 'NOT_APPLICABLE';
      if (this.config.brokerMode === 'live' && this.config.flattradeWsFeed) {
        wsFeedStatus = this.config.flattradeWsFeed.getConnectionState();
      } else if (this.config.brokerMode === 'paper') {
        wsFeedStatus = 'PAPER_MODE';
      }

      return {
        status: 'ok',
        brokerMode: this.config.brokerMode,
        tradingEnabled: this.config.tradingEnabled,
        brokerConnected,
        sessionTokenPresent: sessionState.sessionTokenPresent,
        sessionValid: sessionState.sessionValid,
        sessionValidity: sessionState.sessionValidity,
        wsFeedStatus,
        wsFeedHealthy: this.config.brokerMode === 'live'
          ? sessionState.sessionValid && !!this.config.flattradeWsFeed?.isMarketDataReady()
          : false,
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
        // Broker errors may echo the request code or token. Keep them out of logs and responses.
        this.app.log.error('Flattrade OAuth exchange failed');
        reply.code(502).send({ error: 'OAuth exchange failed. Retry authentication.' });
      }
    };

    // Exact Flattrade OAuth Callback endpoint
    this.app.get('/api/auth/flattrade/callback', flattradeCallbackHandler);
    // Legacy alias for backwards compatibility with earlier portal registrations
    this.app.get('/auth/flattrade/callback', flattradeCallbackHandler);

    // -------------------------------------------------------------
    // Device Provisioning Endpoints
    // -------------------------------------------------------------

    /**
     * POST /api/auth/provision-device
     * Secure owner provisioning workflow:
     * - Requires X-Device-Id header
     * - Validates high-entropy enrollmentSecret
     * - Issues a 30-day JWT containing { sub: 'scalpx-owner', role: 'owner', deviceId }
     * - Stores device authorization in SQLite
     */
    this.app.post('/api/auth/provision-device', async (request, reply) => {
      const deviceId = request.headers['x-device-id'];
      if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length === 0) {
        reply.code(400).send({ error: 'Missing required X-Device-Id header' });
        return;
      }

      const parsed = ProvisionDeviceSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.issues,
        });
        return;
      }

      const { enrollmentSecret, deviceName } = parsed.data;
      const expectedSecret = this.config.enrollmentSecret;
      if (!expectedSecret || enrollmentSecret !== expectedSecret) {
        reply.code(401).send({ error: 'Invalid or missing enrollment secret' });
        return;
      }

      // Generate 30-day device-bound JWT
      const token = jwt.sign(
        { sub: 'scalpx-owner', role: 'owner', deviceId },
        this.config.jwtSecret,
        { algorithm: 'HS256', expiresIn: '30d' }
      );

      await this.stateStore.authorizeDevice(deviceId, deviceName);

      return {
        status: 'ok',
        token,
        deviceId,
        expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      };
    });

    /**
     * POST /api/auth/revoke-device
     * Revokes device authorization (requires authenticated session).
     */
    this.app.post('/api/auth/revoke-device', async (request, reply) => {
      const deviceId = request.headers['x-device-id'] as string;
      await this.stateStore.revokeDevice(deviceId);
      return { status: 'ok', message: `Device ${deviceId} successfully revoked` };
    });

    // -------------------------------------------------------------
    // Authenticated API Endpoints
    // -------------------------------------------------------------

    // Get Login URL (Fallback)
    this.app.get('/api/auth/login-url', async () => {
      return { loginUrl: this.sessionService.getLoginUrl() };
    });

    // Single-User Daily OTP Login (Primary)
    this.app.post('/api/auth/daily-login', async (request, reply) => {
      const parsed = DailyOtpSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'OTP must be a 6-digit numeric string',
          details: parsed.error.issues,
        });
        return;
      }

      try {
        const result = await this.sessionService.loginWithDailyOtp(parsed.data.otp);
        return {
          status: 'ok',
          message: 'Daily Flattrade authentication successful',
          brokerConnected: true,
          tradeDate: result.tradeDate,
          tokenGeneratedAt: result.tokenGeneratedAt,
        };
      } catch (err: unknown) {
        if (err instanceof CooldownActiveError) {
          reply.code(429).send({
            error: err.message,
            remainingSec: err.remainingSec,
          });
          return;
        }

        if (err instanceof InvalidOtpError) {
          reply.code(401).send({
            error: 'Invalid OTP or authentication failed. Check the current OTP and try again.',
          });
          return;
        }

        if (err instanceof FallbackRequiredError) {
          reply.code(502).send({
            error: 'Browser fallback required: Flattrade requires browser authentication for this attempt.',
            fallbackRequired: true,
          });
          return;
        }

        if (err instanceof TokenExchangeError || err instanceof AuthSessionFailedError) {
          reply.code(502).send({
            error: 'Flattrade authentication is temporarily unavailable. Retry later.',
          });
          return;
        }

        this.app.log.error('Daily Flattrade authentication failed');
        reply.code(502).send({
          error: 'Daily Flattrade authentication failed. Retry or use browser authentication.',
        });
      }
    });

    // Flattrade Authentication & Session Status Endpoint
    this.app.get('/api/auth/status', async () => {
      const sessionState = await this.sessionService.getSessionState();
      const sessionValid = sessionState.sessionValid;
      const wsFeed = this.config.flattradeWsFeed;
      const wsFeedStatus = this.config.brokerMode === 'paper'
        ? 'PAPER_MODE'
        : wsFeed?.getConnectionState() ?? 'DISCONNECTED';
      const wsTransportConnected = this.config.brokerMode === 'paper' ? false : !!wsFeed?.isTransportConnected();
      const wsAuthenticated = this.config.brokerMode === 'paper' ? false : !!wsFeed?.isAuthenticatedConnection();
      const marketDataReady = this.config.brokerMode === 'paper'
        ? false
        : sessionValid && wsTransportConnected && wsAuthenticated && !!wsFeed?.isMarketDataReady();
      const brokerConnected = this.config.brokerMode === 'paper' ? false : sessionValid && wsAuthenticated;
      const wsFeedHealthy = marketDataReady;

      let status = 'AUTHENTICATION_REQUIRED';
      if (this.sessionService.isAuthenticating()) {
        status = 'AUTHENTICATING';
      } else if (sessionState.sessionValidity === 'INVALID') {
        status = this.sessionService.getLastAuthError() ? 'AUTHENTICATION_FAILED' : 'AUTHENTICATION_REQUIRED';
      } else if (sessionState.sessionValidity === 'UNKNOWN') {
        status = 'SESSION_VALIDATION_UNAVAILABLE';
      } else if (this.config.brokerMode === 'paper') {
        status = 'PAPER_MODE';
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
        brokerMode: this.config.brokerMode,
        tradingEnabled: this.config.tradingEnabled,
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
      if (this.config.brokerMode === 'live') {
        reply.code(503).send({ error: 'Live option chain is unavailable until a validated instrument master and fresh underlying quote are configured.' });
        return;
      }

      if (this.broker.getOptionChain) {
        const rawChain = await this.broker.getOptionChain(exch, symbol, '0', parsed.data.strikes);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain = rawChain as any;
        if (chain && Array.isArray(chain.strikes)) {
          return {
            ...chain,
            dataSource: this.config.brokerMode === 'paper' ? 'SIMULATED' : 'BROKER',
            simulated: this.config.brokerMode === 'paper',
          };
        }
      }

      return { symbol, expiry: '', strikes: [], dataSource: 'SIMULATED', simulated: true };
    });

    // 1-Click Order Execution — blocked when TRADING_ENABLED=false
    this.app.post('/api/orders/one-click', async (request, reply) => {
      const blocked = this.tradingBlockedReason();
      if (blocked) {
        reply.code(403).send({ error: blocked });
        return;
      }

      const parsed = OneClickOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
        return;
      }

      const body = parsed.data;
      if (this.config.brokerMode === 'live') {
        reply.code(503).send({ error: 'Live orders are blocked until token, trading symbol, expiry, and lot size can be verified against the authoritative instrument master.' });
        return;
      }
      const totalQty = body.lots * body.lotSize;

      // Fetch quote for current LTP
      const quote = await this.broker.getQuotes(body.exchange, body.token);
      const parsedLtp = Number.parseFloat(quote.lp ?? '');
      if (quote.stat !== 'Ok' || !Number.isFinite(parsedLtp) || parsedLtp <= 0) {
        reply.code(422).send({ error: 'A valid live broker quote is required before placing an order.' });
        return;
      }
      const ltpPaise = Math.round(parsedLtp * 100);
      const bestAskPaise = quote.sp1 ? Math.round(parseFloat(quote.sp1) * 100) : undefined;

      const ladderConfig = body.ladderConfig ?? {
        stepSizePaise: 500, // 5.00
        breakoutBufferPaise: 100, // 1.00
        slippageBufferPaise: 150, // 1.50
      };

      try {
        const pos = await this.orderManager.enterPosition({
          commandId: body.commandId,
          token: body.token,
          symbol: body.tradingSymbol,
          exchange: body.exchange,
          quantity: totalQty,
          ltpPaise,
          bestAskPaise,
          stepSizePaise: ladderConfig.stepSizePaise,
          breakoutBufferPaise: ladderConfig.breakoutBufferPaise,
          slippageBufferPaise: ladderConfig.slippageBufferPaise,
          nextMilestonePaise: ladderConfig.firstMilestonePaise,
          initialSlTriggerPaise: body.initialSlPoints ? ltpPaise - Math.round(body.initialSlPoints * 100) : undefined,
          initialSlLimitPaise: body.initialSlPoints ? ltpPaise - Math.round((body.initialSlPoints + 1.5) * 100) : undefined,
        });

        // Broadcast immediate event
        this.wsHub?.broadcastEvent('ORDER_FILLED', {
          token: pos.token,
          symbol: pos.symbol,
          entryPricePaise: pos.entryPricePaise,
          quantity: pos.quantity,
        });

        return pos;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.wsHub?.broadcastEvent('ORDER_REJECTED', {
          token: body.token,
          symbol: body.tradingSymbol,
          reason: errMsg,
        });
        reply.code(422).send({ error: errMsg });
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
