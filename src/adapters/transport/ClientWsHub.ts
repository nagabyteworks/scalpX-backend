import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
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
  throttleIntervalMs?: number; // Default 150 ms
}

export interface PositionSnapshotItem {
  token: string;
  symbol: string;
  side: 'BUY' | 'SELL';
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
  marketData: MarketDataSnapshot | null;
}

export interface MarketDataContract {
  token: string;
  symbol: string;
  exchange: string;
  lotSize: number | null;
}

export interface MarketDataSelection {
  indexSymbol: string;
  spot: MarketDataContract;
  expiry: string;
  atmStrike: number;
  call: MarketDataContract;
  put: MarketDataContract;
  strikes: Array<{
    strikePrice: number;
    call: MarketDataContract | null;
    put: MarketDataContract | null;
  }>;
}

export interface MarketDataSnapshot {
  indexSymbol: string;
  spotToken: string;
  spotLtpPaise: number | null;
  spotTimestamp: number | null;
  selectedExpiry: string;
  atmStrike: number;
  ceSymbol: string;
  ceToken: string;
  ceLotSize: number | null;
  ceLtpPaise: number | null;
  ceTimestamp: number | null;
  peSymbol: string;
  peToken: string;
  peLotSize: number | null;
  peLtpPaise: number | null;
  peTimestamp: number | null;
  marketDataTimestamp: number | null;
  feedStatus: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'STALE' | 'WAITING_FOR_TICK';
  strikes: Array<{
    strikePrice: number;
    ceToken: string | null;
    ceLotSize: number | null;
    ceSymbol: string | null;
    ceLtpPaise: number | null;
    ceTimestamp: number | null;
    peToken: string | null;
    peLotSize: number | null;
    peSymbol: string | null;
    peLtpPaise: number | null;
    peTimestamp: number | null;
  }>;
}

export class ClientWsHub {
  private readonly config: ClientWsHubConfig;
  private readonly engine: RatchetLadderEngine;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly latestLtpMap = new Map<string, number>();
  private readonly latestTicks = new Map<string, Tick>();
  private marketDataSelection: MarketDataSelection | null = null;
  private feedStatus: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' = 'DISCONNECTED';
  private throttleTimer: NodeJS.Timeout | null = null;

  constructor(config: ClientWsHubConfig, engine: RatchetLadderEngine) {
    this.config = config;
    this.engine = engine;
  }

  attach(server: http.Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
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
    return true;
  }

  /**
   * Updates latest market price cache from live feed ticks.
   */
  updateTick(tick: Tick): void {
    this.latestLtpMap.set(tick.token, tick.ltpPaise);
    if (tick.exchange) {
      this.latestTicks.set(`${tick.exchange.toUpperCase()}|${tick.token}`, tick);
    }
  }

  setMarketDataSelection(selection: MarketDataSelection | null): void {
    this.marketDataSelection = selection;
  }

  setFeedStatus(status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'FEED_STALE'): void {
    this.feedStatus = status === 'FEED_STALE' ? 'CONNECTED' : status;
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
      const unrealizedPnl = (ltp - pos.entryPricePaise) * pos.quantity * (pos.side === 'BUY' ? 1 : -1);

      return {
        token: pos.token,
        symbol: pos.symbol,
        side: pos.side,
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
      marketData: this.buildMarketDataSnapshot(),
    };
  }

  private buildMarketDataSnapshot(): MarketDataSnapshot | null {
    const selection = this.marketDataSelection;
    if (!selection) return null;

    const now = Date.now();
    const staleAfterMs = 3_000;
    const feedAuthenticated = this.feedStatus === 'CONNECTED';
    const readContract = (contract: MarketDataContract) => {
      const tick = this.latestTicks.get(`${contract.exchange.toUpperCase()}|${contract.token}`);
      const fresh = feedAuthenticated && tick !== undefined && now - tick.timestamp <= staleAfterMs;
      return {
        tick,
        ltpPaise: fresh ? tick.ltpPaise : null,
        timestamp: fresh ? tick.timestamp : null,
        hadStaleTick: tick !== undefined && !fresh,
      };
    };

    const spot = readContract(selection.spot);
    const call = readContract(selection.call);
    const put = readContract(selection.put);
    const allFresh = spot.ltpPaise !== null && call.ltpPaise !== null && put.ltpPaise !== null;
    const hasStaleTick = spot.hadStaleTick || call.hadStaleTick || put.hadStaleTick;
    const feedStatus = this.feedStatus !== 'CONNECTED'
      ? this.feedStatus
      : allFresh
        ? 'CONNECTED'
        : hasStaleTick
          ? 'STALE'
          : 'WAITING_FOR_TICK';

    return {
      indexSymbol: selection.indexSymbol,
      spotToken: selection.spot.token,
      spotLtpPaise: spot.ltpPaise,
      spotTimestamp: spot.timestamp,
      selectedExpiry: selection.expiry,
      atmStrike: selection.atmStrike,
      ceSymbol: selection.call.symbol,
      ceToken: selection.call.token,
      ceLotSize: selection.call.lotSize,
      ceLtpPaise: call.ltpPaise,
      ceTimestamp: call.timestamp,
      peSymbol: selection.put.symbol,
      peToken: selection.put.token,
      peLotSize: selection.put.lotSize,
      peLtpPaise: put.ltpPaise,
      peTimestamp: put.timestamp,
      marketDataTimestamp: allFresh
        ? Math.min(spot.timestamp!, call.timestamp!, put.timestamp!)
        : null,
      feedStatus,
      strikes: selection.strikes.map((strike) => {
        const ce = strike.call ? readContract(strike.call) : null;
        const pe = strike.put ? readContract(strike.put) : null;
        return {
          strikePrice: strike.strikePrice,
          ceToken: strike.call?.token ?? null,
          ceLotSize: strike.call?.lotSize ?? null,
          ceSymbol: strike.call?.symbol ?? null,
          ceLtpPaise: ce?.ltpPaise ?? null,
          ceTimestamp: ce?.timestamp ?? null,
          peToken: strike.put?.token ?? null,
          peLotSize: strike.put?.lotSize ?? null,
          peSymbol: strike.put?.symbol ?? null,
          peLtpPaise: pe?.ltpPaise ?? null,
          peTimestamp: pe?.timestamp ?? null,
        };
      }),
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
