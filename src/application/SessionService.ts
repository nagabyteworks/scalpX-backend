import type { FlattradeRestAdapter } from '../adapters/broker/FlattradeRestAdapter.js';
import type { StateStorePort } from '../domain/ports/StateStorePort.js';
import type { FlattradeAuthClient } from '../adapters/broker/FlattradeAuthClient.js';
import type { FlattradeWsAdapter } from '../adapters/broker/FlattradeWsAdapter.js';
import type { ReconcilerService } from './ReconcilerService.js';
import type { ClientWsHub } from '../adapters/transport/ClientWsHub.js';

export function getTodayDateIST(date = new Date()): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalTemporal = (globalThis as any).Temporal;
  if (globalTemporal && globalTemporal.Now) {
    const today = globalTemporal.Now.plainDateISO('Asia/Kolkata');
    return today.toString(); // "YYYY-MM-DD"
  }

  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const istDate = new Date(utc + 5.5 * 3600000);
  const year = istDate.getFullYear();
  const month = String(istDate.getMonth() + 1).padStart(2, '0');
  const day = String(istDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class CooldownActiveError extends Error {
  public readonly remainingSec: number;

  constructor(remainingSec: number) {
    super(`Too many failed login attempts. Retry after ${remainingSec} seconds.`);
    this.name = 'CooldownActiveError';
    this.remainingSec = remainingSec;
  }
}

export interface SessionServiceOptions {
  brokerMode?: 'paper' | 'live';
  authClient?: FlattradeAuthClient;
  wsFeed?: FlattradeWsAdapter;
  reconciler?: ReconcilerService;
  wsHub?: ClientWsHub;
  cooldownMs?: number; // default: 15,000 (15 seconds)
}

export type SessionValidity = 'VALID' | 'INVALID' | 'UNKNOWN' | 'SIMULATED';

export interface SessionState {
  sessionTokenPresent: boolean;
  sessionValid: boolean;
  sessionValidity: SessionValidity;
}

export class SessionService {
  private readonly broker: FlattradeRestAdapter;
  private readonly stateStore: StateStorePort;
  private readonly apiKey: string;
  private readonly brokerMode: 'paper' | 'live';
  private authClient?: FlattradeAuthClient;
  private wsFeed?: FlattradeWsAdapter;
  private reconciler?: ReconcilerService;
  private wsHub?: ClientWsHub;

  private readonly cooldownMs: number;
  private cooldownUntil = 0;
  private authenticating = false;
  private lastAuthError: string | null = null;
  private sessionValidationCache: { token: string; checkedAt: number; validity: SessionValidity } | null = null;

  constructor(
    broker: FlattradeRestAdapter,
    stateStore: StateStorePort,
    apiKey: string,
    options: SessionServiceOptions = {}
  ) {
    this.broker = broker;
    this.stateStore = stateStore;
    this.apiKey = apiKey;
    this.brokerMode = options.brokerMode ?? 'paper';
    this.authClient = options.authClient;
    this.wsFeed = options.wsFeed;
    this.reconciler = options.reconciler;
    this.wsHub = options.wsHub;
    this.cooldownMs = options.cooldownMs ?? 15000;
  }

  isAuthenticating(): boolean {
    return this.authenticating;
  }

  getLastAuthError(): string | null {
    return this.lastAuthError;
  }

  hasValidSession(): boolean {
    if (this.brokerMode === 'paper') {
      return true;
    }
    return !!this.sessionValidationCache &&
      this.sessionValidationCache.validity === 'VALID' &&
      Date.now() - this.sessionValidationCache.checkedAt < 15000 &&
      this.sessionValidationCache.token === this.getSessionToken();
  }

  private getSessionToken(): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof (this.broker as any).getSessionToken === 'function'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (this.broker as any).getSessionToken()
      : null;
  }

  async getSessionState(): Promise<SessionState> {
    if (this.brokerMode === 'paper') {
      return { sessionTokenPresent: !!this.getSessionToken(), sessionValid: true, sessionValidity: 'SIMULATED' };
    }

    const token = this.getSessionToken();
    if (!token) return { sessionTokenPresent: false, sessionValid: false, sessionValidity: 'INVALID' };

    const todayToken = await this.stateStore.getDailySession(getTodayDateIST());
    if (!todayToken || todayToken !== token) {
      return { sessionTokenPresent: true, sessionValid: false, sessionValidity: 'INVALID' };
    }

    const now = Date.now();
    if (this.sessionValidationCache?.token === token && now - this.sessionValidationCache.checkedAt < 15000) {
      const validity = this.sessionValidationCache.validity;
      return { sessionTokenPresent: true, sessionValid: validity === 'VALID', sessionValidity: validity };
    }

    // Flattrade's documented, read-only /Limits request validates the jKey.
    // A network/service failure is UNKNOWN; it must not be confused with an invalid token.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const validity: SessionValidity = typeof (this.broker as any).validateSession === 'function'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? await (this.broker as any).validateSession()
      : 'UNKNOWN';
    this.sessionValidationCache = { token, checkedAt: now, validity };
    return { sessionTokenPresent: true, sessionValid: validity === 'VALID', sessionValidity: validity };
  }

  setAuthClient(authClient: FlattradeAuthClient): void {
    this.authClient = authClient;
  }

  setWsFeed(wsFeed: FlattradeWsAdapter): void {
    this.wsFeed = wsFeed;
  }

  setReconciler(reconciler: ReconcilerService): void {
    this.reconciler = reconciler;
  }

  setWsHub(wsHub: ClientWsHub): void {
    this.wsHub = wsHub;
  }

  /**
   * Generates daily OAuth login URL for Flattrade v2 browser authentication fallback.
   */
  getLoginUrl(): string {
    return `https://auth.flattrade.in/?app_key=${encodeURIComponent(this.apiKey)}`;
  }

  /**
   * Alias matching the contract naming for the browser fallback URL.
   */
  getOAuthLoginUrl(): string {
    return this.getLoginUrl();
  }

  /**
   * Exchanges OAuth request_code for session token, persists to SQLite, and updates broker client.
   */
  async exchangeAndSaveToken(requestCode: string): Promise<string> {
    let token: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (this.brokerMode === 'paper' && typeof (this.broker as any).exchangeOAuthToken !== 'function') {
      token = `PAPER_SESSION_${Date.now()}`;
    } else {
      token = await this.broker.exchangeOAuthToken(requestCode);
    }
    const today = getTodayDateIST();
    await this.stateStore.saveDailySession(today, token);
    if (typeof this.broker.setSessionToken === 'function') {
      this.broker.setSessionToken(token);
    }
    this.sessionValidationCache = { token, checkedAt: Date.now(), validity: 'VALID' };

    if (this.wsFeed) {
      this.wsFeed.updateSessionToken(token);
      // Do not hide broker WebSocket authentication failures from the caller.
      await this.wsFeed.connect();
    }

    if (this.reconciler) {
      await this.reconciler.reconcile().catch(() => {});
    }

    if (this.wsHub) {
      this.wsHub.broadcastEvent('SESSION_UPDATED', { brokerConnected: true, tradeDate: today });
    }

    return token;
  }

  /**
   * Alias matching contract naming for OAuth callback exchange.
   */
  async handleOAuthCallback(requestCode: string): Promise<string> {
    return this.exchangeAndSaveToken(requestCode);
  }

  /**
   * Loads today's valid token on server restart from SQLite WAL store.
   */
  async getValidTodaySession(): Promise<string | null> {
    const today = getTodayDateIST();
    const token = await this.stateStore.getDailySession(today);
    if (token) {
      if (typeof this.broker.setSessionToken === 'function') {
        this.broker.setSessionToken(token);
      }
      const sessionState = await this.getSessionState();
      return sessionState.sessionValid ? token : null;
    }
    return null;
  }

  /**
   * Single-User Daily OTP/TOTP Login.
   * Runs the 3-step server-side handshake from the EC2 static IP in live mode,
   * or provides instant paper trading connection in paper mode.
   * Enforces a 15-second cooldown upon any failed attempt.
   */
  async loginWithDailyOtp(otp: string): Promise<{ brokerConnected: true; tradeDate: string; tokenGeneratedAt: string }> {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      const remainingSec = Math.ceil((this.cooldownUntil - now) / 1000);
      throw new CooldownActiveError(remainingSec);
    }

    const today = getTodayDateIST();
    const tokenGeneratedAt = new Date().toISOString();

    // Paper Mode: Instant mock session
    if (this.brokerMode === 'paper') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const paperToken = `PAPER_TOKEN_${today}_${Date.now()}`;
      await this.stateStore.saveDailySession(today, paperToken);
      if (typeof (this.broker as any).setSessionToken === 'function') {
        this.broker.setSessionToken(paperToken);
      }
      this.wsHub?.broadcastEvent('SESSION_UPDATED', { brokerConnected: true, tradeDate: today });
      this.cooldownUntil = 0;
      return {
        brokerConnected: true,
        tradeDate: today,
        tokenGeneratedAt,
      };
    }

    // Live Mode: Run 3-step FlattradeAuthClient handshake
    this.authenticating = true;
    try {
      if (!this.authClient) {
        throw new Error('FlattradeAuthClient is not configured for live broker mode');
      }

      const token = await this.authClient.authenticateWithDailyOtp(otp);

      // Persist to SQLite WAL store
      await this.stateStore.saveDailySession(today, token);

      // Update Rest Adapter token
      this.broker.setSessionToken(token);
      this.sessionValidationCache = { token, checkedAt: Date.now(), validity: 'VALID' };

      // Connect / Update WS Feed
      if (this.wsFeed) {
        this.wsFeed.updateSessionToken(token);
        await this.wsFeed.connect();
      }

      // Reconcile open positions
      if (this.reconciler) {
        await this.reconciler.reconcile().catch(() => {});
      }

      // Broadcast update to mobile clients
      if (this.wsHub) {
        this.wsHub.broadcastEvent('SESSION_UPDATED', { brokerConnected: true, tradeDate: today });
      }

      // Success clears any cooldown and last error
      this.cooldownUntil = 0;
      this.lastAuthError = null;

      return {
        brokerConnected: true,
        tradeDate: today,
        tokenGeneratedAt,
      };
    } catch (err: unknown) {
      // Activate 15-second cooldown on failure
      this.cooldownUntil = Date.now() + this.cooldownMs;
      this.lastAuthError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.authenticating = false;
    }
  }
}
