export type PositionSide = 'BUY' | 'SELL';
export type LadderPositionStatus = 'OPEN' | 'CLOSED' | 'MANUAL_INTERVENTION';

export interface LadderPosition {
  token: string;
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPricePaise: number;

  // Local-only ratchet configuration (strictly in-memory integer paise)
  nextMilestonePaise: number;
  stepSizePaise: number;
  breakoutBufferPaise: number;
  slippageBufferPaise: number;

  // Active exchange Stop-Loss state
  activeSlOrderId: string | null;
  activeSlTriggerPaise: number | null;
  activeSlLimitPaise: number | null;

  // Non-blocking in-flight mutex lock
  isUpdating: boolean;

  // Lifecycle status and control
  status: LadderPositionStatus;
  isPaused: boolean;

  createdAt: number;
  updatedAt: number;
}

export interface LadderConfigUpdate {
  nextMilestonePaise?: number;
  stepSizePaise?: number;
  breakoutBufferPaise?: number;
  slippageBufferPaise?: number;
  paused?: boolean;
}
