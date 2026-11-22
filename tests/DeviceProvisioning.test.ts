import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { HttpServer } from '../src/adapters/transport/HttpServer.js';
import { SqliteStateStore } from '../src/adapters/persistence/SqliteStateStore.js';
import { MockBrokerAdapter } from './mock/MockBrokerAdapter.js';
import { RatchetLadderEngine } from '../src/domain/engines/RatchetLadderEngine.js';
import { RiskGuard } from '../src/domain/engines/RiskGuard.js';
import { OrderManager } from '../src/application/OrderManager.js';
import { SessionService } from '../src/application/SessionService.js';
import { ReconcilerService } from '../src/application/ReconcilerService.js';
import type { MarketFeedPort } from '../src/domain/ports/MarketFeedPort.js';

describe('Device Provisioning & Authorization Security', () => {
  const JWT_SECRET = 'TEST_JWT_SECRET_KEY_123456';
  const ENROLLMENT_SECRET = 'MASTER_ENROLLMENT_SECRET_12345';
  let server: HttpServer;
  let stateStore: SqliteStateStore;
  let broker: MockBrokerAdapter;
  let baseUrl: string;

  beforeEach(async () => {
    stateStore = new SqliteStateStore(':memory:');
    broker = new MockBrokerAdapter();
    const engine = new RatchetLadderEngine(broker, stateStore);
    const riskGuard = new RiskGuard({ rateLimitCapacity: 6, refillRatePerSec: 6 }, stateStore);

    const feed: MarketFeedPort = {
      subscribe: async () => {},
      unsubscribe: async () => {},
      onTick: () => {},
    };

    const orderManager = new OrderManager(broker, feed, engine, riskGuard, stateStore);
    const sessionService = new SessionService(broker as any, stateStore, 'API_KEY');
    const reconciler = new ReconcilerService(broker, feed, engine, stateStore);

    server = new HttpServer(
      {
        jwtSecret: JWT_SECRET,
        enrollmentSecret: ENROLLMENT_SECRET,
        deviceTotpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        tradingEnabled: true,
      },
      sessionService,
      orderManager,
      reconciler,
      engine,
      stateStore,
      broker
    );

    // Bind to any ephemeral port on 127.0.0.1
    baseUrl = await server.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await server.close();
    stateStore.close();
  });

  describe('POST /api/auth/provision-device', () => {
    it('pre-authorizes a device without bypassing TOTP authentication', async () => {
      // Direct call via Fastify inject to avoid TCP connection in sandbox
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/auth/provision-device',
        headers: {
          'x-device-id': '398d304e-422d-4516-b589-00c9e73b99a1',
        },
        payload: {
          enrollmentSecret: ENROLLMENT_SECRET,
          deviceName: 'Pixel 9 Pro',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.status).toBe('ok');
      expect(data.deviceId).toBe('398d304e-422d-4516-b589-00c9e73b99a1');
      expect(data.token).toBeUndefined();

      // Verify device is recorded as authorized
      const isAuth = await stateStore.isDeviceAuthorized('398d304e-422d-4516-b589-00c9e73b99a1');
      expect(isAuth).toBe(true);
    });

    it('issues a short-lived JWT for a pre-authorized device and rejects TOTP replay', async () => {
      const deviceId = '398d304e-422d-4516-b589-00c9e73b99a1';
      await stateStore.authorizeDevice(deviceId, 'Test phone');
      vi.setSystemTime(new Date(59_000));
      const payload = { deviceId, totp: '287082', deviceName: 'Test phone' };
      const first = await server.app.inject({ method: 'POST', url: '/api/auth/device/authenticate', payload });
      expect(first.statusCode).toBe(200);
      const issued = JSON.parse(first.payload);
      expect(issued.expiresIn).toBe(900);
      expect((jwt.verify(issued.accessToken, JWT_SECRET) as any).deviceId).toBe(deviceId);

      const replay = await server.app.inject({ method: 'POST', url: '/api/auth/device/authenticate', payload });
      expect(replay.statusCode).toBe(401);
      vi.useRealTimers();
    });

    it('rejects provisioning when enrollment secret is incorrect', async () => {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/auth/provision-device',
        headers: {
          'x-device-id': 'device-uuid-1234',
        },
        payload: {
          enrollmentSecret: 'WRONG_SECRET',
        },
      });

      expect(res.statusCode).toBe(401);
      const data = JSON.parse(res.payload);
      expect(data.error).toContain('Invalid or missing enrollment secret');
    });

    it('rejects provisioning without X-Device-Id header', async () => {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/auth/provision-device',
        payload: {
          enrollmentSecret: ENROLLMENT_SECRET,
        },
      });

      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.payload);
      expect(data.error).toContain('Missing required X-Device-Id header');
    });
  });

  describe('Device-binding and Revocation Enforcment', () => {
    it('allows API access when token deviceId matches X-Device-Id', async () => {
      // Provision device
      const provRes = await server.app.inject({
        method: 'POST',
        url: '/api/auth/provision-device',
        headers: { 'x-device-id': 'device-uuid-1234' },
        payload: { enrollmentSecret: ENROLLMENT_SECRET },
      });
      const token = jwt.sign({ sub: 'scalpx-owner', role: 'owner', deviceId: 'device-uuid-1234' }, JWT_SECRET, { expiresIn: '15m' });

      // Access protected endpoint
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/trades/today',
        headers: {
          'x-device-id': 'device-uuid-1234',
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects API access when X-Device-Id does not match token claim', async () => {
      // Token issued for device A
      const token = jwt.sign({ sub: 'user', deviceId: 'device-A' }, JWT_SECRET);

      // Request sent with device B header
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/trades/today',
        headers: {
          'x-device-id': 'device-B',
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error).toContain('Device ID mismatch');
    });

    it('rejects API access when device authorization has been revoked', async () => {
      // Provision device
      const provRes = await server.app.inject({
        method: 'POST',
        url: '/api/auth/provision-device',
        headers: { 'x-device-id': 'device-uuid-revoke' },
        payload: { enrollmentSecret: ENROLLMENT_SECRET },
      });
      const token = jwt.sign({ sub: 'scalpx-owner', role: 'owner', deviceId: 'device-uuid-revoke' }, JWT_SECRET, { expiresIn: '15m' });

      // Revoke device
      await stateStore.revokeDevice('device-uuid-revoke');

      // Request from revoked device
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/trades/today',
        headers: {
          'x-device-id': 'device-uuid-revoke',
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload).error).toContain('Device authorization has been revoked');
    });

    it('GET /docs/swagger.json serves OpenAPI 3.0 specification without authentication', async () => {
      const res = await server.app.inject({
        method: 'GET',
        url: '/docs/swagger.json',
      });

      expect(res.statusCode).toBe(200);
      const swagger = JSON.parse(res.payload);
      expect(swagger.openapi).toBe('3.0.3');
      expect(swagger.info.title).toContain('scalpX');
      expect(swagger.paths['/api/orders/one-click']).toBeDefined();
      expect(swagger.paths['/api/auth/provision-device']).toBeDefined();
      expect(swagger.paths['/api/auth/flattrade/callback']).toBeDefined();
    });
  });
});
