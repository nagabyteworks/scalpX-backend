import WebSocket from 'ws';
import type { MarketFeedPort } from '../../domain/ports/MarketFeedPort.js';
import type { Tick } from '../../domain/models/Tick.js';
import { toPaise } from '../../domain/models/Money.js';
import type { OrderUpdateEvent } from './FlattradeProtocol.js';

export interface FlattradeWsConfig {
  wsUrl?: string;
  userId: string;
  accountId?: string;
  sessionToken: string;
  watchdogIntervalMs?: number;
  staleTimeoutMs?: number;
  marketHoursOverride?: boolean | null;
}

export type FeedStatusListener = (status: 'CONNECTED' | 'DISCONNECTED' | 'FEED_STALE' | 'RECONNECTING') => void;
export type OrderUpdateListener = (update: OrderUpdateEvent) => void;

/**
 * Checks whether current time falls within NSE regular market trading hours (09:15 - 15:30 IST, Mon-Fri).
 * Uses Node 26 Temporal if available; otherwise falls back to IST timezone calculation.
 */
export function isMarketHoursIST(override?: boolean | null): boolean {
  if (override !== undefined && override !== null) {
    return override;
  }

  // Node 26 Temporal check
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalTemporal = (globalThis as any).Temporal;
  if (globalTemporal && globalTemporal.Now) {
    const now = globalTemporal.Now.zonedDateTimeISO('Asia/Kolkata');
    const dayOfWeek = now.dayOfWeek; // 1 (Mon) - 7 (Sun)
    if (dayOfWeek > 5) return false;
    const minutes = now.hour * 60 + now.minute;
    return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
  }

  // Fallback using UTC + 5.5h (Asia/Kolkata)
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 3600000);
  const day = ist.getDay(); // 0 is Sun, 6 is Sat
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

export class FlattradeWsAdapter implements MarketFeedPort {
  private readonly config: FlattradeWsConfig;
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private isAuthenticated = false;
  private isDestroyed = false;

  private readonly subscribedTokens = new Set<string>();
  private tickCallback: ((tick: Tick) => void) | null = null;
  private readonly statusListeners: FeedStatusListener[] = [];
  private readonly orderUpdateListeners: OrderUpdateListener[] = [];

  // Stale-Feed Watchdog state
  private lastTickTimestamp = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: FlattradeWsConfig) {
    this.config = config;
    this.wsUrl = config.wsUrl || process.env.FLATTRADE_WS_URL || 'wss://piconnect.flattrade.in/PiConnectWSTp/';
    this.startWatchdog();
  }

  onTick(callback: (tick: Tick) => void): void {
    this.tickCallback = callback;
  }

  onStatus(listener: FeedStatusListener): void {
    this.statusListeners.push(listener);
  }

  onOrderUpdate(listener: OrderUpdateListener): void {
    this.orderUpdateListeners.push(listener);
  }

  setSessionToken(token: string): void {
    this.config.sessionToken = token;
  }

  updateSessionToken(token: string): void {
    this.setSessionToken(token);
  }

  private emitStatus(status: 'CONNECTED' | 'DISCONNECTED' | 'FEED_STALE' | 'RECONNECTING'): void {
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Safe dispatch
      }
    }
  }

  private emitOrderUpdate(update: OrderUpdateEvent): void {
    for (const listener of this.orderUpdateListeners) {
      try {
        listener(update);
      } catch {
        // Safe dispatch
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isDestroyed) return;

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          this.reconnectAttempt = 0;
          this.sendAuthHandshake();
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data);
          if (this.isAuthenticated) {
            resolve();
          }
        });

        this.ws.on('close', () => {
          this.isAuthenticated = false;
          this.emitStatus('DISCONNECTED');
          this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
          if (!this.isAuthenticated) {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private sendAuthHandshake(): void {
    const payload = {
      t: 'c',
      uid: this.config.userId,
      actid: this.config.accountId ?? this.config.userId,
      susertoken: this.config.sessionToken,
      source: 'API',
    };
    this.send(payload);
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(data.toString());

      // 1. Connection acknowledgement
      if (msg.t === 'ck' && msg.s === 'OK') {
        this.isAuthenticated = true;
        this.lastTickTimestamp = Date.now();
        this.emitStatus('CONNECTED');
        this.resubscribeAll();
        return;
      }

      // 2. Touchline ticks
      if (msg.t === 'tk' || msg.t === 'tf') {
        this.lastTickTimestamp = Date.now();
        if (msg.tk && msg.lp) {
          const ltpPaise = toPaise(msg.lp);
          const tick: Tick = {
            token: String(msg.tk),
            ltpPaise,
            bestBidPaise: msg.bp1 ? toPaise(msg.bp1) : undefined,
            bestAskPaise: msg.sp1 ? toPaise(msg.sp1) : undefined,
            volume: msg.v ? parseInt(String(msg.v), 10) : undefined,
            timestamp: Date.now(),
          };
          this.tickCallback?.(tick);
        }
        return;
      }

      // 3. Order Update events
      if (msg.t === 'om') {
        const update: OrderUpdateEvent = {
          norenordno: msg.norenordno,
          status: msg.status,
          avgprc: msg.avgprc,
          fillshares: msg.fillshares,
          rejreason: msg.rejreason,
          token: msg.token,
          tsym: msg.tsym,
        };
        this.emitOrderUpdate(update);
        return;
      }
    } catch {
      // Ignore unparseable raw packets
    }
  }

  async subscribe(tokens: string[]): Promise<void> {
    for (const tok of tokens) {
      this.subscribedTokens.add(tok);
    }

    if (this.isAuthenticated && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const keyStr = tokens.map((tok) => (tok.includes('|') ? tok : `NFO|${tok}`)).join('#');
      this.send({ t: 't', k: keyStr });
    }
  }

  async unsubscribe(tokens: string[]): Promise<void> {
    for (const tok of tokens) {
      this.subscribedTokens.delete(tok);
    }
    if (this.isAuthenticated && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const keyStr = tokens.map((tok) => (tok.includes('|') ? tok : `NFO|${tok}`)).join('#');
      this.send({ t: 'u', k: keyStr });
    }
  }

  private resubscribeAll(): void {
    if (this.subscribedTokens.size > 0) {
      const tokens = Array.from(this.subscribedTokens);
      const keyStr = tokens.map((tok) => (tok.includes('|') ? tok : `NFO|${tok}`)).join('#');
      this.send({ t: 't', k: keyStr });
    }
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Stale-Feed Watchdog:
   * During market hours (09:15 - 15:30 IST), if no tick arrives for 3,000 ms
   * while subscribed to >= 1 token, emit FEED_STALE, force-terminate, and reconnect.
   */
  private startWatchdog(): void {
    const intervalMs = this.config.watchdogIntervalMs ?? 1000;
    const staleTimeout = this.config.staleTimeoutMs ?? 3000;

    this.watchdogTimer = setInterval(() => {
      if (this.isDestroyed || !this.isAuthenticated || this.subscribedTokens.size === 0) {
        return;
      }

      const inMarketHours = isMarketHoursIST(this.config.marketHoursOverride);
      if (!inMarketHours) {
        return;
      }

      const elapsed = Date.now() - this.lastTickTimestamp;
      if (elapsed >= staleTimeout) {
        this.emitStatus('FEED_STALE');
        this.forceTerminateAndReconnect();
      }
    }, intervalMs);
  }

  private forceTerminateAndReconnect(): void {
    try {
      this.ws?.terminate();
    } catch {
      // Ignore termination error
    }
    this.isAuthenticated = false;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimer) return;

    // Exponential backoff: 500ms -> 1s -> 2s -> 5s max
    const backoffDelays = [500, 1000, 2000, 5000];
    const delay = backoffDelays[Math.min(this.reconnectAttempt, backoffDelays.length - 1)] ?? 5000;
    this.reconnectAttempt++;

    this.emitStatus('RECONNECTING');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Returns the current connection state for health reporting.
   * Never exposes the session token.
   */
  getConnectionState(): 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'DESTROYED' {
    if (this.isDestroyed) return 'DESTROYED';
    if (this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN) return 'CONNECTED';
    if (this.reconnectTimer) return 'RECONNECTING';
    return 'DISCONNECTED';
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.terminate();
    } catch {
      // Ignore
    }
    this.ws = null;
    this.subscribedTokens.clear();
  }
}
