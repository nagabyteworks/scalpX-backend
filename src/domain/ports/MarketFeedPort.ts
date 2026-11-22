import type { Tick } from '../models/Tick.js';

export interface MarketFeedPort {
  /** Instrument identifiers must be exchange-qualified as EXCHANGE|TOKEN. */
  subscribe(instrumentIds: string[]): Promise<void>;
  unsubscribe(instrumentIds: string[]): Promise<void>;
  onTick(callback: (tick: Tick) => void): void;
}
