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
  initialTickTimeoutMs?: number;
  marketHoursOverride?: boolean | null;
}

export type FeedStatusListener = (status: 'CONNECTED' | 'DISCONNECTED' | 'FEED_STALE' | 'RECONNECTING') => void;
export type OrderUpdateListener = (update: OrderUpdateEvent) => void;

export type MarketDataWaitErrorCode =
  | 'BROKER_SESSION_UNAVAILABLE'
  | 'WEBSOCKET_NOT_CONNECTED'
  | 'SUBSCRIPTION_REJECTED'
  | 'INITIAL_TICK_NOT_RECEIVED'
  | 'STALE_MARKET_DATA'
  | 'SUBSCRIPTION_CANCELLED';

export class MarketDataWaitError extends Error {
  constructor(readonly code: MarketDataWaitErrorCode, message: string) {
    super(message);
    this.name = 'MarketDataWaitError';
  }
}

interface TickWaiter {
  resolve: (tick: Tick) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

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
  private authenticationRejected = false;

  private readonly subscribedTokens = new Set<string>();
  private readonly subscriptionStartedAt = new Map<string, number>();
  private readonly tickWaiters = new Map<string, Set<TickWaiter>>();
  private tickCallback: ((tick: Tick) => void) | null = null;
  private readonly statusListeners: FeedStatusListener[] = [];
  private readonly orderUpdateListeners: OrderUpdateListener[] = [];

  // Stale-Feed Watchdog state
  private lastTickTimestamp = 0;
  private readonly lastTickByToken = new Map<string, number>();
  private readonly latestTickByToken = new Map<string, Tick>();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionReject: ((error: Error) => void) | null = null;

  constructor(config: FlattradeWsConfig) {
    this.config = config;
    // Flattrade's current Pi API v2 websocket endpoint.
    this.wsUrl = config.wsUrl || process.env.FLATTRADE_WS_URL || 'wss://piconnect.flattrade.in/PiConnectWSAPI/';
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
    if (this.config.sessionToken !== token) {
      this.authenticationRejected = false;
    }
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

  private normalizeInstrumentIds(instrumentIds: string[]): string[] {
    return instrumentIds.map((instrumentId) => {
      const match = /^([A-Za-z0-9]+)\|([^|#]+)$/.exec(instrumentId);
      if (!match) throw new Error(`Market subscriptions require EXCHANGE|TOKEN identifiers: ${instrumentId}`);
      return `${match[1]!.toUpperCase()}|${match[2]!}`;
    });
  }

  async connect(): Promise<void> {
    if (this.isDestroyed) return;

    return new Promise<void>((resolve, reject) => {
      this.connectionReject = reject;
      const timeout = setTimeout(() => {
        this.connectionReject = null;
        reject(new Error('Timed out waiting for Flattrade WebSocket authentication acknowledgement'));
        this.ws?.terminate();
      }, 10000);
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          this.reconnectAttempt = 0;
          this.sendAuthHandshake();
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data);
          if (this.isAuthenticated) {
            clearTimeout(timeout);
            this.connectionReject = null;
            resolve();
          }
        });

        this.ws.on('close', () => {
          this.isAuthenticated = false;
          this.lastTickTimestamp = 0;
          this.lastTickByToken.clear();
          this.latestTickByToken.clear();
          this.rejectAllTickWaiters(new MarketDataWaitError(
            'WEBSOCKET_NOT_CONNECTED',
            'Flattrade market-data WebSocket disconnected before the tick arrived.'
          ));
          clearTimeout(timeout);
          this.connectionReject?.(new Error('Flattrade WebSocket disconnected before authentication completed'));
          this.connectionReject = null;
          this.emitStatus('DISCONNECTED');
          this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
          if (!this.isAuthenticated) {
            clearTimeout(timeout);
            this.connectionReject = null;
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
      t: 'a',
      uid: this.config.userId,
      actid: this.config.accountId ?? this.config.userId,
      accesstoken: this.config.sessionToken,
      source: 'API',
    };
    this.send(payload);
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(data.toString());

      // 1. Connection acknowledgement
      if (msg.t === 'ak' && String(msg.s).toUpperCase() === 'OK') {
        this.isAuthenticated = true;
        this.authenticationRejected = false;
        this.lastTickTimestamp = 0;
        this.emitStatus('CONNECTED');
        this.resubscribeAll();
        return;
      }

      if (msg.t === 'ak') {
        this.isAuthenticated = false;
        this.authenticationRejected = true;
        const error = new MarketDataWaitError(
          'BROKER_SESSION_UNAVAILABLE',
          'Flattrade rejected WebSocket authentication.'
        );
        this.rejectAllTickWaiters(error);
        this.connectionReject?.(error);
        this.connectionReject = null;
        this.ws?.close(4001, 'Broker WebSocket authentication rejected');
        return;
      }

      // 2. Touchline ticks
      if (msg.t === 'tk' || msg.t === 'tf') {
        const status = typeof msg.s === 'string' ? msg.s.toUpperCase() : '';
        if (status && status !== 'OK') {
          if (msg.e && msg.tk) {
            this.rejectTickWaiters(
              `${String(msg.e).toUpperCase()}|${String(msg.tk)}`,
              new MarketDataWaitError('SUBSCRIPTION_REJECTED', 'Flattrade rejected the market-data subscription.')
            );
          }
          return;
        }
        if (msg.e && msg.tk && msg.lp !== undefined && msg.lp !== null) {
          const instrumentId = `${String(msg.e).toUpperCase()}|${String(msg.tk)}`;
          if (!this.subscribedTokens.has(instrumentId)) return;
          try {
            const ltpPaise = toPaise(msg.lp);
            if (ltpPaise <= 0) return;
            const receivedAt = Date.now();
            this.lastTickTimestamp = receivedAt;
            this.lastTickByToken.set(instrumentId, receivedAt);
            const tick: Tick = {
              token: String(msg.tk),
              exchange: String(msg.e).toUpperCase(),
              ltpPaise,
              bestBidPaise: msg.bp1 ? toPaise(msg.bp1) : undefined,
              bestAskPaise: msg.sp1 ? toPaise(msg.sp1) : undefined,
              volume: msg.v ? parseInt(String(msg.v), 10) : undefined,
              timestamp: receivedAt,
            };
            this.latestTickByToken.set(instrumentId, tick);
            this.tickCallback?.(tick);
            this.resolveTickWaiters(instrumentId, tick);
          } catch {
            console.warn('Flattrade WebSocket ignored an invalid market tick', { instrumentId });
          }
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
      console.warn('Flattrade WebSocket ignored an unparseable message');
    }
  }

  async subscribe(tokens: string[]): Promise<void> {
    const instrumentIds = [...new Set(this.normalizeInstrumentIds(tokens))];
    if (this.authenticationRejected) {
      throw new MarketDataWaitError(
        'BROKER_SESSION_UNAVAILABLE',
        'Flattrade rejected the current WebSocket session.'
      );
    }
    const newlySubscribed = instrumentIds.filter((id) => !this.subscribedTokens.has(id));
    if (newlySubscribed.length === 0) return;
    const now = Date.now();
    for (const id of newlySubscribed) {
      this.subscribedTokens.add(id);
      this.subscriptionStartedAt.set(id, now);
    }

    if (this.isAuthenticated && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const keyStr = newlySubscribed.join('#');
      this.send({ t: 't', k: keyStr });
    }
  }

  async unsubscribe(tokens: string[]): Promise<void> {
    const instrumentIds = this.normalizeInstrumentIds(tokens);
    for (const id of instrumentIds) {
      this.subscribedTokens.delete(id);
      this.lastTickByToken.delete(id);
      this.latestTickByToken.delete(id);
      this.subscriptionStartedAt.delete(id);
      this.rejectTickWaiters(
        id,
        new MarketDataWaitError('SUBSCRIPTION_CANCELLED', 'Market-data subscription was cancelled.')
      );
    }
    if (this.isAuthenticated && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const keyStr = instrumentIds.join('#');
      this.send({ t: 'u', k: keyStr });
    }
  }

  getLatestTick(instrumentId: string): Tick | null {
    return this.latestTickByToken.get(instrumentId) ?? null;
  }

  waitForTick(instrumentId: string, timeoutMs = this.config.initialTickTimeoutMs ?? 5000): Promise<Tick> {
    const normalizedId = this.normalizeInstrumentIds([instrumentId])[0]!;
    if (this.authenticationRejected) {
      return Promise.reject(new MarketDataWaitError(
        'BROKER_SESSION_UNAVAILABLE',
        'Flattrade rejected the current WebSocket session.'
      ));
    }
    const cachedTick = this.latestTickByToken.get(normalizedId);
    const maxAgeMs = this.config.staleTimeoutMs ?? 3000;
    if (cachedTick && Date.now() - cachedTick.timestamp <= maxAgeMs) {
      return Promise.resolve(cachedTick);
    }
    if (!this.subscribedTokens.has(normalizedId)) {
      return Promise.reject(new MarketDataWaitError(
        'SUBSCRIPTION_REJECTED',
        'Market-data instrument has not been subscribed.'
      ));
    }

    return new Promise<Tick>((resolve, reject) => {
      const waiter: TickWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeTickWaiter(normalizedId, waiter);
          reject(new MarketDataWaitError(
            'INITIAL_TICK_NOT_RECEIVED',
            'Timed out waiting for the first Flattrade market-data tick.'
          ));
        }, Math.max(1, timeoutMs)),
      };
      const waiters = this.tickWaiters.get(normalizedId) ?? new Set<TickWaiter>();
      waiters.add(waiter);
      this.tickWaiters.set(normalizedId, waiters);
    });
  }

  private resolveTickWaiters(instrumentId: string, tick: Tick): void {
    const waiters = this.tickWaiters.get(instrumentId);
    if (!waiters) return;
    this.tickWaiters.delete(instrumentId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(tick);
    }
  }

  private rejectTickWaiters(instrumentId: string, error: Error): void {
    const waiters = this.tickWaiters.get(instrumentId);
    if (!waiters) return;
    this.tickWaiters.delete(instrumentId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  private removeTickWaiter(instrumentId: string, waiter: TickWaiter): void {
    const waiters = this.tickWaiters.get(instrumentId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.tickWaiters.delete(instrumentId);
  }

  private rejectAllTickWaiters(error: Error): void {
    for (const instrumentId of this.tickWaiters.keys()) {
      this.rejectTickWaiters(instrumentId, error);
    }
  }

  private resubscribeAll(): void {
    if (this.subscribedTokens.size > 0) {
      const tokens = Array.from(this.subscribedTokens);
      for (const id of tokens) this.lastTickByToken.delete(id);
      for (const id of tokens) this.latestTickByToken.delete(id);
      const now = Date.now();
      for (const id of tokens) this.subscriptionStartedAt.set(id, now);
      this.lastTickTimestamp = 0;
      const keyStr = tokens.join('#');
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

      const now = Date.now();
      const staleSubscriptionExists = [...this.subscribedTokens].some((id) => {
        const lastTick = this.lastTickByToken.get(id) ?? this.subscriptionStartedAt.get(id) ?? this.lastTickTimestamp;
        return now - lastTick >= staleTimeout;
      });
      if (staleSubscriptionExists) {
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
    if (this.isDestroyed || this.authenticationRejected || this.reconnectTimer) return;

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

  isMarketDataReady(maxAgeMs = this.config.staleTimeoutMs ?? 3000): boolean {
    if (!this.isAuthenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.subscribedTokens.size === 0) return false;
    const now = Date.now();
    return [...this.subscribedTokens].every((instrumentId) => {
      const receivedAt = this.lastTickByToken.get(instrumentId);
      return receivedAt !== undefined && now - receivedAt <= maxAgeMs;
    });
  }

  isTransportConnected(): boolean {
    return !this.isDestroyed && this.ws?.readyState === WebSocket.OPEN;
  }

  isAuthenticatedConnection(): boolean {
    return this.isTransportConnected() && this.isAuthenticated;
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
    this.subscriptionStartedAt.clear();
    this.lastTickByToken.clear();
    this.latestTickByToken.clear();
    this.rejectAllTickWaiters(new MarketDataWaitError(
      'SUBSCRIPTION_CANCELLED',
      'Flattrade market-data feed was stopped.'
    ));
  }
}
