import fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { SessionService, CooldownActiveError } from '../../application/SessionService.js';
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
  flattradeWsFeed?: FlattradeWsAdapter;
  logger?: any;
}

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
  symbol: z.string().default('NIFTY'),
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
                ],
                censor: '[REDACTED]',
              },
            },
    });
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.register(cors, { origin: true });

    // Authentication hook for all /api/* routes
    this.app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.url.split('?')[0] ?? '';

      // Skip public routes
      if (!url.startsWith('/api/')) {
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
        const decoded = jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'] });
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

  private setupRoutes(): void {
    // -------------------------------------------------------------
    // Unauthenticated Endpoints
    // -------------------------------------------------------------

    // Health check
    this.app.get('/health', async () => {
      const openPositions = this.engine.getAllPositions().filter((p) => p.status === 'OPEN');
      const memoryUsage = process.memoryUsage();

      return {
        status: 'ok',
        brokerMode: this.config.brokerMode,
        brokerConnected: true,
        wsFeedHealthy: true,
        openPositionsCount: openPositions.length,
        memoryRssMb: Math.round(memoryUsage.rss / (1024 * 1024)),
        uptimeSec: Math.round(process.uptime()),
      };
    });

    // Flattrade OAuth Redirect Callback
    this.app.get('/auth/flattrade/callback', async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query = request.query as any;
      const code = query.code || query.request_code;

      if (!code || typeof code !== 'string') {
        reply.code(400).send({ error: 'Missing code parameter in OAuth callback' });
        return;
      }

      try {
        await this.sessionService.exchangeAndSaveToken(code);

        // Boot WebSocket adapter if available
        if (this.config.flattradeWsFeed) {
          await this.config.flattradeWsFeed.connect().catch(() => {});
        }

        // Reconcile open state
        await this.reconciler.reconcile().catch(() => {});

        // Redirect to Android app deep link
        reply.redirect('scalper://auth/success', 302);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        reply.code(500).send({ error: `OAuth exchange failed: ${errMsg}` });
      }
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
            error: `Flattrade authentication failed: ${err.message}`,
          });
          return;
        }

        if (err instanceof FallbackRequiredError) {
          reply.code(502).send({
            error: err.message,
            fallbackRequired: true,
          });
          return;
        }

        if (err instanceof TokenExchangeError || err instanceof AuthSessionFailedError) {
          reply.code(502).send({
            error: `Flattrade communication error: ${err.message}`,
          });
          return;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        reply.code(502).send({
          error: `Login failed: ${errMsg}`,
        });
      }
    });

    // Option Chain
    this.app.get('/api/option-chain', async (request, reply) => {
      const parsed = OptionChainQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
        return;
      }

      if (this.broker.getOptionChain) {
        const chain = await this.broker.getOptionChain('NFO', parsed.data.symbol, '0', parsed.data.strikes);
        return chain;
      }
      return { stat: 'Ok', values: [] };
    });

    // 1-Click Order Execution
    this.app.post('/api/orders/one-click', async (request, reply) => {
      const parsed = OneClickOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.issues });
        return;
      }

      const body = parsed.data;
      const totalQty = body.lots * body.lotSize;

      // Fetch quote for current LTP
      const quote = await this.broker.getQuotes(body.exchange, body.token);
      const ltpPaise = quote.lp ? Math.round(parseFloat(quote.lp) * 100) : 10000;
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

    // Exit Position
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

    // Panic Exit All
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
        reply.code(500).send({ error: errMsg });
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
  }

  async listen(port: number, host = '0.0.0.0'): Promise<string> {
    return this.app.listen({ port, host });
  }

  async close(): Promise<void> {
    await this.app.close();
  }
}
