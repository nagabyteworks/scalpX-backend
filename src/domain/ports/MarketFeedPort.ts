import type { Tick } from '../models/Tick.js';

export interface MarketFeedPort {
  subscribe(tokens: string[]): Promise<void>;
  unsubscribe(tokens: string[]): Promise<void>;
  onTick(callback: (tick: Tick) => void): void;
}
