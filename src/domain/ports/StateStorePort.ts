import type { LadderPosition, LadderPositionStatus } from '../models/LadderPosition.js';

export interface OrderAuditRecord {
  commandId: string;
  token: string;
  symbol: string;
  action: 'PLACE_SL' | 'MODIFY_SL' | 'EXIT' | 'CANCEL' | 'PLACE_ENTRY';
  orderId?: string;
  triggerPricePaise?: number;
  pricePaise?: number;
  status: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface ClosedTradeRecord {
  token: string;
  tradingSymbol: string;
  qty: number;
  entryPaise: number;
  exitPaise: number;
  realizedPnlPaise: number;
  closedAt: number;
}

export interface StateStorePort {
  savePosition(position: LadderPosition): Promise<void>;
  updatePositionStatus(token: string, status: LadderPositionStatus): Promise<void>;
  recordOrderAudit(entry: OrderAuditRecord): Promise<void>;
  getPosition(token: string): Promise<LadderPosition | null>;
  getAllActiveLadders(): Promise<LadderPosition[]>;
  saveDailySession(tradeDate: string, tokenEncryptedOrLocal: string): Promise<void>;
  getDailySession(tradeDate: string): Promise<string | null>;
  recordClosedTrade(trade: ClosedTradeRecord): Promise<void>;
  consumeTotpStep(step: number): Promise<boolean>;
}
