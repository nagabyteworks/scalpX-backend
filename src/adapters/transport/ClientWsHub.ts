import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import type { RatchetLadderEngine } from '../../domain/engines/RatchetLadderEngine.js';
import type { Tick } from '../../domain/models/Tick.js';

export type CriticalEventType =
  | 'ORDER_FILLED'
  | 'SL_RATCHETED'
  | 'ORDER_REJECTED'
  | 'FEED_STALE'
  | 'MANUAL_INTERVENTION_REQUIRED'
  | 'SESSION_UPDATED';

export interface ClientWsHubConfig {
  jwtSecret: string;
  throttleIntervalMs?: number; // Default 150 ms
}

export interface PositionSnapshotItem {
  token: string;
  symbol: string;
  quantity: number;
  entryPricePaise: number;
  currentLtpPaise: number;
  unrealizedPnlPaise: number;
  nextMilestonePaise: number;
  activeSlTriggerPaise: number | null;
  activeSlLimitPaise: number | null;
  isPaused: boolean;
  status: string;
}

export interface TradingSnapshot {
  type: 'SNAPSHOT';
  timestamp: number;
  positions: PositionSnapshotItem[];
  openPositionsCount: number;
}

export class ClientWsHub {
  private readonly config: ClientWsHubConfig;
  private readonly engine: RatchetLadderEngine;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly latestLtpMap = new Map<string, number>();
  private throttleTimer: NodeJS.Timeout | null = null;

  constructor(config: ClientWsHubConfig, engine: RatchetLadderEngine) {
    this.config = config;
    this.engine = engine;
  }

  attach(server: http.Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      // 1. Authenticate WebSocket upgrade
      const auth = this.authenticateRequest(req);
      if (!auth) {
        ws.close(4001, 'Unauthorized: Invalid JWT or missing Device-Id');
        return;
      }

      this.clients.add(ws);

      // Send initial snapshot immediately upon connection
      const initialSnapshot = this.buildSnapshot();
      ws.send(JSON.stringify(initialSnapshot));

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    this.startThrottledBroadcast();
  }

  private authenticateRequest(req: http.IncomingMessage): boolean {
    // Strictly header-based authentication. Invariant: Never allow JWTs in query parameters.
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }

    const deviceId = req.headers['x-device-id'];
    if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length === 0) {
      return false;
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'] }) as {
        deviceId?: string;
      };
      // Enforce device-binding claim if present
      if (decoded.deviceId && decoded.deviceId !== deviceId) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Updates latest market price cache from live feed ticks.
   */
  updateTick(tick: Tick): void {
    this.latestLtpMap.set(tick.token, tick.ltpPaise);
  }

  /**
   * Coalesces live market ticks and broadcasts a compact TradingSnapshot every 150 ms.
   * Invariant: Never forwards raw broker ticks 1:1.
   */
  private startThrottledBroadcast(): void {
    const interval = this.config.throttleIntervalMs ?? 150;
    this.throttleTimer = setInterval(() => {
      if (this.clients.size === 0) return;

      const snapshot = this.buildSnapshot();
      const payload = JSON.stringify(snapshot);

      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    }, interval);
  }

  private buildSnapshot(): TradingSnapshot {
    const activePositions = this.engine.getAllPositions().filter((p) => p.status === 'OPEN');
    const items: PositionSnapshotItem[] = activePositions.map((pos) => {
      const ltp = this.latestLtpMap.get(pos.token) ?? pos.entryPricePaise;
      const unrealizedPnl = (ltp - pos.entryPricePaise) * pos.quantity;

      return {
        token: pos.token,
        symbol: pos.symbol,
        quantity: pos.quantity,
        entryPricePaise: pos.entryPricePaise,
        currentLtpPaise: ltp,
        unrealizedPnlPaise: unrealizedPnl,
        nextMilestonePaise: pos.nextMilestonePaise,
        activeSlTriggerPaise: pos.activeSlTriggerPaise,
        activeSlLimitPaise: pos.activeSlLimitPaise,
        isPaused: pos.isPaused,
        status: pos.status,
      };
    });

    return {
      type: 'SNAPSHOT',
      timestamp: Date.now(),
      positions: items,
      openPositionsCount: items.length,
    };
  }

  /**
   * Immediately pushes critical events, bypassing the 150 ms throttled interval.
   */
  broadcastEvent(type: CriticalEventType, data: unknown): void {
    if (this.clients.size === 0) return;

    const message = JSON.stringify({
      type,
      timestamp: Date.now(),
      data,
    });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.throttleTimer) {
      clearInterval(this.throttleTimer);
      this.throttleTimer = null;
    }
    for (const client of this.clients) {
      try {
        client.close(1000, 'Server shutting down');
      } catch {
        // Ignore
      }
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}
