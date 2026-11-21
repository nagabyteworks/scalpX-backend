import type { FlattradeRestAdapter } from '../adapters/broker/FlattradeRestAdapter.js';
import type { StateStorePort } from '../domain/ports/StateStorePort.js';

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

export class SessionService {
  private readonly broker: FlattradeRestAdapter;
  private readonly stateStore: StateStorePort;
  private readonly apiKey: string;

  constructor(broker: FlattradeRestAdapter, stateStore: StateStorePort, apiKey: string) {
    this.broker = broker;
    this.stateStore = stateStore;
    this.apiKey = apiKey;
  }

  /**
   * Generates daily OAuth login URL for Flattrade v2 authentication.
   */
  getLoginUrl(): string {
    return `https://auth.flattrade.in/?app_key=${encodeURIComponent(this.apiKey)}`;
  }

  /**
   * Exchanges OAuth request_code for session token, persists to SQLite, and updates broker client.
   */
  async exchangeAndSaveToken(requestCode: string): Promise<string> {
    const token = await this.broker.exchangeOAuthToken(requestCode);
    const today = getTodayDateIST();
    await this.stateStore.saveDailySession(today, token);
    this.broker.setSessionToken(token);
    return token;
  }

  /**
   * Loads today's valid token on server restart from SQLite WAL store.
   */
  async getValidTodaySession(): Promise<string | null> {
    const today = getTodayDateIST();
    const token = await this.stateStore.getDailySession(today);
    if (token) {
      this.broker.setSessionToken(token);
      return token;
    }
    return null;
  }
}
