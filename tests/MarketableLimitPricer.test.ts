import { describe, it, expect } from 'vitest';
import { MarketableLimitPricer } from '../src/domain/engines/MarketableLimitPricer.js';

describe('MarketableLimitPricer', () => {
  it('calculates marketable limit price for BUY crossing the spread upwards', () => {
    // LTP = 100.00 (10000 paise), fixed buffer = 1.00 (100 paise)
    const price = MarketableLimitPricer.calculatePrice('BUY', 10000, undefined, { fixedPaise: 100 });
    expect(price).toBe(10100); // 101.00
    expect(price % 5).toBe(0);
  });

  it('uses bestAsk when available for BUY', () => {
    // LTP = 100.00 (10000), Best Ask = 100.20 (10020), fixed buffer 10 paise
    const price = MarketableLimitPricer.calculatePrice('BUY', 10000, 10020, { fixedPaise: 10 });
    expect(price).toBe(10030);
    expect(price % 5).toBe(0);
  });

  it('calculates marketable limit price for SELL crossing the spread downwards', () => {
    // LTP = 100.00 (10000 paise), fixed buffer = 1.00 (100 paise)
    const price = MarketableLimitPricer.calculatePrice('SELL', 10000, undefined, { fixedPaise: 100 });
    expect(price).toBe(9900); // 99.00
    expect(price % 5).toBe(0);
  });

  it('uses bestBid when available for SELL', () => {
    // LTP = 100.00 (10000), Best Bid = 99.80 (9980), fixed buffer 10 paise
    const price = MarketableLimitPricer.calculatePrice('SELL', 10000, 9980, { fixedPaise: 10 });
    expect(price).toBe(9970);
    expect(price % 5).toBe(0);
  });

  it('supports basis point percentage buffers', () => {
    // LTP = 100.00 (10000), 50 bps = 0.5% = 50 paise
    const buyPrice = MarketableLimitPricer.calculatePrice('BUY', 10000, undefined, { percentBps: 50 });
    expect(buyPrice).toBe(10050);

    const sellPrice = MarketableLimitPricer.calculatePrice('SELL', 10000, undefined, { percentBps: 50 });
    expect(sellPrice).toBe(9950);
  });

  it('always enforces tick alignment of 5 paise', () => {
    // Unaligned buffer: 10000 + 13 paise = 10013 -> rounded up to 10015
    const price = MarketableLimitPricer.calculatePrice('BUY', 10000, undefined, { fixedPaise: 13 });
    expect(price).toBe(10015);
    expect(price % 5).toBe(0);
  });
});
