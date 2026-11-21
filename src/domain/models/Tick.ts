export interface Tick {
  token: string;
  ltpPaise: number;
  bestBidPaise?: number;
  bestAskPaise?: number;
  volume?: number;
  timestamp: number;
}
