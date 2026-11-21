import type { OrderSide } from '../models/OrderIntent.js';
import { roundDownToTick, roundUpToTick } from '../models/Money.js';

export interface PricingBufferConfig {
  fixedPaise?: number;
  percentBps?: number; // 1 bps = 0.01%
  tickPaise?: number; // Default 5 paise
}

/**
 * Calculates a tick-aligned marketable limit order price that crosses the spread
 * to guarantee immediate fills without using MKT order types.
 */
export class MarketableLimitPricer {
  /**
   * Calculates marketable limit price in paise.
   *
   * @param side 'BUY' or 'SELL'
   * @param ltpPaise Last Traded Price in integer paise
   * @param depthPricePaise Optional bestAsk (for BUY) or bestBid (for SELL)
   * @param buffer Optional buffer configuration (fixed paise or bps)
   * @returns Tick-aligned limit price in integer paise
   */
  static calculatePrice(
    side: OrderSide,
    ltpPaise: number,
    depthPricePaise?: number,
    buffer?: PricingBufferConfig
  ): number {
    const tick = buffer?.tickPaise ?? 5;
    const basePrice = depthPricePaise !== undefined && depthPricePaise > 0 ? depthPricePaise : ltpPaise;

    let bufferPaise = 0;
    if (buffer?.fixedPaise !== undefined) {
      bufferPaise = buffer.fixedPaise;
    } else if (buffer?.percentBps !== undefined) {
      bufferPaise = Math.round((basePrice * buffer.percentBps) / 10000);
    } else {
      // Default: 2 ticks = 10 paise buffer
      bufferPaise = 2 * tick;
    }

    if (side === 'BUY') {
      const rawPrice = basePrice + bufferPaise;
      return roundUpToTick(rawPrice, tick);
    } else {
      const rawPrice = Math.max(tick, basePrice - bufferPaise);
      return roundDownToTick(rawPrice, tick);
    }
  }
}
