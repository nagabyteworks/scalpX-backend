export interface Tick {
  token: string;
  exchange?: string;
  ltpPaise: number;
  bestBidPaise?: number;
  bestAskPaise?: number;
  volume?: number;
  timestamp: number;
}
