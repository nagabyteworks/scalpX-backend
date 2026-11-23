import {
  FlattradeIndexListError,
  FlattradeOAuthError,
  type FlattradeRestAdapter,
} from '../adapters/broker/FlattradeRestAdapter.js';
import type { FlattradeIndexListDiagnostics } from '../adapters/broker/FlattradeRestAdapter.js';
import type { StateStorePort } from '../domain/ports/StateStorePort.js';
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

export interface SessionServiceOptions {
  wsFeed?: FlattradeWsAdapter;
  reconciler?: ReconcilerService;
  wsHub?: ClientWsHub;
}

export type SessionValidity = 'VALID' | 'INVALID' | 'UNKNOWN';

export type IndexResolutionErrorCode =
  | 'INDEX_NOT_FOUND'
  | 'INVALID_INDEX_TOKEN'
  | 'AMBIGUOUS_INDEX'
  | 'INVALID_INDEX_EXCHANGE'
  | 'BROKER_SESSION_UNAVAILABLE'
  | 'BROKER_API_FAILURE'
  | 'INVALID_INDEX_RESPONSE'
  | 'UNSUPPORTED_INDEX';

export class IndexResolutionError extends Error {
  constructor(
    readonly code: IndexResolutionErrorCode,
    message: string,
    readonly diagnostics?: FlattradeIndexListDiagnostics
  ) {
    super(message);
    this.name = 'IndexResolutionError';
  }
}

export type SessionAuthenticationStage =
  | 'oauth_exchange'
  | 'token_persistence'
  | 'session_validation'
  | 'websocket_connection';

export class SessionAuthenticationError extends Error {
  constructor(readonly stage: SessionAuthenticationStage, message: string) {
    super(message);
    this.name = 'SessionAuthenticationError';
  }
}

export interface SessionState {
  sessionTokenPresent: boolean;
  sessionValid: boolean;
  sessionValidity: SessionValidity;
}

export class SessionService {
  private readonly broker: FlattradeRestAdapter;
  private readonly stateStore: StateStorePort;
  private readonly apiKey: string;
  private wsFeed?: FlattradeWsAdapter;
  private reconciler?: ReconcilerService;
  private wsHub?: ClientWsHub;
  private readonly indexInstrumentCache = new Map<string, { tradeDate: string; instrumentId: string }>();

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
    this.wsFeed = options.wsFeed;
    this.reconciler = options.reconciler;
    this.wsHub = options.wsHub;
  }

  hasValidSession(): boolean {
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

  async getSensexSpotInstrumentId(): Promise<string> {
    return this.getIndexSpotInstrumentId('SENSEX');
  }

  async getIndexSpotInstrumentId(symbol: string): Promise<string> {
    const requested = symbol.trim().toUpperCase().replace(/\s+/g, ' ');
    const canonical = requested === 'NIFTY 50'
      ? 'NIFTY'
      : requested === 'NIFTY BANK'
        ? 'BANKNIFTY'
        : requested;
    const aliases: Record<string, { exchange: 'NSE' | 'BSE'; names: ReadonlySet<string> }> = {
      NIFTY: { exchange: 'NSE', names: new Set(['NIFTY', 'NIFTY 50']) },
      SENSEX: { exchange: 'BSE', names: new Set(['SENSEX']) },
      BANKNIFTY: { exchange: 'NSE', names: new Set(['BANKNIFTY', 'NIFTY BANK']) },
    };
    const definition = aliases[canonical];
    if (!definition) {
      throw new IndexResolutionError('UNSUPPORTED_INDEX', `Unsupported index symbol: ${canonical || '(empty)'}.`);
    }

    const tradeDate = getTodayDateIST();
    const cached = this.indexInstrumentCache.get(canonical);
    if (cached?.tradeDate === tradeDate) return cached.instrumentId;

    let indices;
    try {
      indices = await this.broker.getIndexList(definition.exchange);
    } catch (error) {
      if (error instanceof FlattradeIndexListError) {
        throw new IndexResolutionError(error.code, error.message, error.diagnostics);
      }
      throw new IndexResolutionError('BROKER_API_FAILURE', 'Flattrade index-list request failed.');
    }

    const matches = indices.filter((index) =>
      definition.names.has(index.idxname.trim().toUpperCase().replace(/\s+/g, ' '))
    );
    if (matches.some((index) => index.exchange !== definition.exchange)) {
      throw new IndexResolutionError(
        'INVALID_INDEX_EXCHANGE',
        `Flattrade returned ${canonical} on an unexpected exchange.`
      );
    }
    if (matches.length === 0) {
      throw new IndexResolutionError(
        'INDEX_NOT_FOUND',
        `Flattrade ${definition.exchange} index list did not contain ${canonical}.`
      );
    }
    if (matches.length > 1) {
      throw new IndexResolutionError(
        'AMBIGUOUS_INDEX',
        `Flattrade ${definition.exchange} index list returned multiple candidates for ${canonical}.`
      );
    }
    const token = matches[0]!.token;
    if (!token || !/^\d+$/.test(token) || !/[1-9]/.test(token)) {
      throw new IndexResolutionError(
        'INVALID_INDEX_TOKEN',
        `Flattrade ${definition.exchange} index list returned an invalid token for ${canonical}.`
      );
    }

    const instrumentId = `${definition.exchange}|${token}`;
    this.indexInstrumentCache.set(canonical, { tradeDate, instrumentId });
    return instrumentId;
  }

  private async ensureSensexSpotSubscription(): Promise<void> {
    if (!this.wsFeed) return;
    const instrumentId = await this.getSensexSpotInstrumentId();
    await this.wsFeed.subscribe([instrumentId]);
  }

  /**
   * Exchanges OAuth request_code for session token, persists to SQLite, and updates broker client.
   */
  async exchangeAndSaveToken(requestCode: string): Promise<string> {
    let token: string;
    try {
      token = await this.broker.exchangeOAuthToken(requestCode);
    } catch (error) {
      if (error instanceof FlattradeOAuthError) throw error;
      throw new SessionAuthenticationError('oauth_exchange', 'Flattrade OAuth token exchange failed.');
    }
    const today = getTodayDateIST();
    try {
      await this.stateStore.saveDailySession(today, token);
    } catch {
      throw new SessionAuthenticationError('token_persistence', 'Could not persist the Flattrade session.');
    }
    if (typeof this.broker.setSessionToken === 'function') {
      this.broker.setSessionToken(token);
    }
    // Do not treat a successful code exchange as proof that the issued session
    // works. Confirm it through Flattrade's documented /Limits endpoint first.
    this.sessionValidationCache = null;
    let validation: SessionState;
    try {
      validation = await this.getSessionState();
    } catch {
      throw new SessionAuthenticationError('session_validation', 'Could not validate the Flattrade session.');
    }
    if (!validation.sessionValid) {
      throw new SessionAuthenticationError('session_validation', validation.sessionValidity === 'UNKNOWN'
        ? 'Flattrade session validation is currently unavailable.'
        : 'Flattrade rejected the exchanged session token.');
    }

    if (this.wsFeed) {
      try {
        this.wsFeed.updateSessionToken(token);
      } catch {
        throw new SessionAuthenticationError('websocket_connection', 'Flattrade WebSocket session update failed.');
      }
      try {
        await this.ensureSensexSpotSubscription();
      } catch {
        console.warn('Flattrade post-login authentication stage failed', { stage: 'websocket_subscription' });
      }
      // Do not hide broker WebSocket authentication failures from the caller.
      try {
        await this.wsFeed.connect();
      } catch {
        throw new SessionAuthenticationError('websocket_connection', 'Flattrade WebSocket connection failed.');
      }
    }

    if (this.reconciler) {
      try {
        const result = await this.reconciler.reconcile();
        if (result.uncertain) {
          console.error('Flattrade post-login authentication stage failed', { stage: 'reconciliation' });
        }
      } catch {
        // Reconciliation is a later, non-fatal stage. Never misreport it as an OAuth exchange failure.
        console.error('Flattrade post-login authentication stage failed', { stage: 'reconciliation' });
      }
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
      if (sessionState.sessionValid) {
        try {
          await this.ensureSensexSpotSubscription();
        } catch (err) {
          console.warn('SENSEX index resolution failed; live spot data remains unavailable:', err instanceof Error ? err.message : 'unknown error');
        }
      }
      return sessionState.sessionValid ? token : null;
    }
    return null;
  }


}
