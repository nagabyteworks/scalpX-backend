import 'dotenv/config';
import { loadConfig } from './config/env.js';
import { SqliteStateStore } from './adapters/persistence/SqliteStateStore.js';
import { RiskGuard } from './domain/engines/RiskGuard.js';
import { RatchetLadderEngine } from './domain/engines/RatchetLadderEngine.js';
import { FlattradeRestAdapter, createBrokerAdapter } from './adapters/broker/FlattradeRestAdapter.js';
import { FlattradeWsAdapter } from './adapters/broker/FlattradeWsAdapter.js';
import { FlattradeAuthClient } from './adapters/broker/FlattradeAuthClient.js';
import { SessionService } from './application/SessionService.js';
import { OrderManager } from './application/OrderManager.js';
import { ReconcilerService } from './application/ReconcilerService.js';
import { HttpServer } from './adapters/transport/HttpServer.js';
import { ClientWsHub } from './adapters/transport/ClientWsHub.js';

// 1. Validate Environment Variables (Fail Fast)
const env = loadConfig();

async function bootstrap() {
  console.log(`🚀 Bootstrapping scalpX Backend (Mode: ${env.BROKER_MODE.toUpperCase()})`);

  // 2. Initialize SQLite State Store
  const stateStore = new SqliteStateStore(env.DB_PATH);

  // 3. Initialize RiskGuard
  const riskGuard = new RiskGuard({
    lotSize: env.DEFAULT_LOT_SIZE,
    maxLotsPerOrder: env.MAX_LOTS_PER_ORDER,
    maxOpenQtyPerSymbol: env.MAX_OPEN_QTY_PER_SYMBOL,
    maxDailyLossPaise: env.MAX_DAILY_LOSS_PAISE,
    rateLimitCapacity: 6,
    refillRatePerSec: 6,
  });

  // 4. Initialize Broker Adapter
  const broker = createBrokerAdapter({
    mode: env.BROKER_MODE,
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
      jwtSecret: env.APP_JWT_SECRET,
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
  if (env.BROKER_MODE === 'live') {
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
      if (status === 'FEED_STALE') {
        clientWsHub.broadcastEvent('FEED_STALE', { message: 'Feed tick silence exceeded 3,000 ms' });
      }
    });
  }

  // 8. Session, Order, and Reconciler Services
  const authClient = new FlattradeAuthClient({
    userId: env.FLATTRADE_USER_ID,
    passwordSha256: env.FLATTRADE_PASSWORD_SHA256,
    apiKey: env.FLATTRADE_API_KEY,
    apiSecret: env.FLATTRADE_API_SECRET,
    authBaseUrl: env.FLATTRADE_AUTH_BASE_URL,
  });

  const sessionService = new SessionService(
    broker instanceof FlattradeRestAdapter ? broker : (broker as any),
    stateStore,
    env.FLATTRADE_API_KEY,
    {
      brokerMode: env.BROKER_MODE,
      authClient,
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
    console.log('✅ Found valid today session token in SQLite WAL.');
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
    }
  } else {
    console.log('ℹ️ No active session for today. Complete OAuth login via /auth/flattrade/callback.');
  }

  // 10. Start Fastify HTTP Server
  const server = new HttpServer(
    {
      jwtSecret: env.APP_JWT_SECRET,
      brokerMode: env.BROKER_MODE,
      flattradeWsFeed: flattradeWs,
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
      await authClient.close().catch(() => {});
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
