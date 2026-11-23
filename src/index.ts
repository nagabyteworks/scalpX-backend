import 'dotenv/config';
import { loadConfig } from './config/env.js';
import { SqliteStateStore } from './adapters/persistence/SqliteStateStore.js';
import { RiskGuard } from './domain/engines/RiskGuard.js';
import { RatchetLadderEngine } from './domain/engines/RatchetLadderEngine.js';
import { FlattradeRestAdapter } from './adapters/broker/FlattradeRestAdapter.js';
import { FlattradeWsAdapter } from './adapters/broker/FlattradeWsAdapter.js';
import { SessionService } from './application/SessionService.js';
import { OrderManager } from './application/OrderManager.js';
import { ReconcilerService } from './application/ReconcilerService.js';
import { HttpServer } from './adapters/transport/HttpServer.js';
import { ClientWsHub } from './adapters/transport/ClientWsHub.js';

// 1. Validate Environment Variables (Fail Fast)
const env = loadConfig();

async function bootstrap() {
  console.log(`🚀 Bootstrapping scalpX Backend (LIVE, Trading: ${env.TRADING_ENABLED ? 'ENABLED' : 'DISABLED'})`);

  // 2. Initialize SQLite State Store (with encryption in LIVE mode)
  const stateStore = new SqliteStateStore(env.DB_PATH, env.DB_SESSION_ENCRYPTION_KEY);

  // 3. Initialize RiskGuard with persistence & priority token bucket rate limiter
  const riskGuard = new RiskGuard(
    {
      rateLimitCapacity: 6,
      refillRatePerSec: 6,
    },
    stateStore // persistence for daily P&L and kill-switch state
  );

  // 4. Initialize Broker Adapter
  const broker = new FlattradeRestAdapter({
    apiKey: env.FLATTRADE_API_KEY,
    apiSecret: env.FLATTRADE_API_SECRET,
    userId: env.FLATTRADE_USER_ID,
    accountId: env.FLATTRADE_ACCOUNT_ID,
  });

  // 5. Initialize Ratchet Ladder Engine
  const engine = new RatchetLadderEngine(broker, stateStore);

  // 6. Initialize Client WebSocket Hub
  const clientWsHub = new ClientWsHub(
    {
      throttleIntervalMs: 150,
    },
    engine
  );

  // Wire engine alerts directly to immediate client push
  engine.onAlert((alert) => {
    if (alert.type === 'MANUAL_INTERVENTION') {
      clientWsHub.broadcastEvent('MANUAL_INTERVENTION_REQUIRED', alert);
    } else if (alert.type === 'SL_MODIFIED' || alert.type === 'SL_PLACED') {
      clientWsHub.broadcastEvent('SL_RATCHETED', alert);
    }
  });

  // 7. Initialize Flattrade WebSocket Feed
  let flattradeWs: FlattradeWsAdapter | undefined;
  flattradeWs = new FlattradeWsAdapter({
      wsUrl: env.FLATTRADE_WS_URL,
      userId: env.FLATTRADE_USER_ID,
      accountId: env.FLATTRADE_ACCOUNT_ID,
      sessionToken: '',
    });

    flattradeWs.onTick((tick) => {
      clientWsHub.updateTick(tick);
      engine.onTick(tick).catch(() => {});
    });

  flattradeWs.onStatus((status) => {
      clientWsHub.setFeedStatus(status);
      if (status === 'FEED_STALE') {
        clientWsHub.broadcastEvent('FEED_STALE', { message: 'Feed tick silence exceeded 3,000 ms' });
      }
  });

  // 8. Session, Order, and Reconciler Services
  const sessionService = new SessionService(
    broker,
    stateStore,
    env.FLATTRADE_API_KEY,
    {
      wsFeed: flattradeWs,
      wsHub: clientWsHub,
    }
  );

  const feedPort = flattradeWs ?? {
    subscribe: async () => {},
    unsubscribe: async () => {},
    onTick: () => {},
  };

  const orderManager = new OrderManager(broker, feedPort, engine, riskGuard, stateStore);
  const reconciler = new ReconcilerService(broker, feedPort, engine, stateStore);
  sessionService.setReconciler(reconciler);

  // 9. Startup Reconciliation
  const todaySession = await sessionService.getValidTodaySession();
  if (todaySession) {
    console.log('✅ Found valid today session token.');
    if (flattradeWs) {
      await flattradeWs.connect().catch((err) => {
        console.warn('⚠️ Flattrade WS connection failed on startup:', err.message);
      });
    }
    const summary = await reconciler.reconcile().catch((err) => {
      console.warn('⚠️ Reconciler error on startup:', err.message);
      return null;
    });
    if (summary) {
      console.log(`🔄 Reconciled: ${summary.checkedLadders} checked, ${summary.closedLadders} closed, ${summary.syncedLadders} active synced.`);
      if (summary.uncertain) {
        console.error(`⛔ Account state UNCERTAIN for tokens: [${summary.uncertainTokens.join(', ')}]. New entries BLOCKED.`);
      }
    }
  } else {
    console.log('ℹ️ No active session for today. Complete browser authorization through GET /api/auth/login-url and the registered OAuth callback.');
  }

  // 10. Start Fastify HTTP Server
  const server = new HttpServer(
    {
      tradingEnabled: env.TRADING_ENABLED,
      flattradeWsFeed: flattradeWs,
      // CORS: set to your Android app's origin or leave false for no CORS
      corsOrigin: false,
    },
    sessionService,
    orderManager,
    reconciler,
    engine,
    stateStore,
    broker,
    clientWsHub
  );

  // Attach WebSocket Hub to HTTP server
  clientWsHub.attach(server.app.server);

  const address = await server.listen(env.PORT, env.HOST);
  console.log(`⚡ scalpX Server listening at ${address}`);

  // 11. Graceful Shutdown Handlers
  let isShuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}. Initiating graceful shutdown...`);

    const openPositions = engine.getAllPositions().filter((p) => p.status === 'OPEN');
    if (openPositions.length > 0) {
      console.error('========================================================================');
      console.error(`⚠️  [CRITICAL SHUTDOWN WARNING]: SERVER SHUTTING DOWN WITH ${openPositions.length} OPEN POSITIONS!`);
      for (const pos of openPositions) {
        console.error(`    - Token: ${pos.token} (${pos.symbol}) Qty: ${pos.quantity} SL: ${pos.activeSlTriggerPaise}`);
      }
      console.error('⚠️  Emergency: Verify positions on Flattrade terminal immediately!');
      console.error('========================================================================');
    }

    try {
      clientWsHub.close();
      flattradeWs?.destroy();
      stateStore.close();
      await server.close();
      console.log('✅ All components cleanly stopped. Goodbye.');
      process.exit(0);
    } catch (err) {
      console.error('❌ Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('❌ Unhandled bootstrap error:', err);
  process.exit(1);
});
