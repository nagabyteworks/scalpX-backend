import { describe, it, expect } from 'vitest';
import { FlattradeRestAdapter } from '../src/adapters/broker/FlattradeRestAdapter.js';
import type { FlattradeQuote } from '../src/adapters/broker/FlattradeProtocol.js';

/**
 * Tests for the safety-critical exitPosition and exitAllPositions methods.
 * These tests use mocked internals to simulate broker responses without network calls.
 */

function createMockAdapter() {
  const adapter = new FlattradeRestAdapter({
    apiKey: 'TEST_KEY',
    apiSecret: 'TEST_SECRET',
    userId: 'FT123456',
    sessionToken: 'MOCK_SESSION',
  });
  return adapter;
}

describe('FlattradeRestAdapter.exitPosition Safety', () => {
  it('throws when LTP is unavailable — NEVER uses a fallback invented price', async () => {
    const adapter = createMockAdapter();

    // Monkey-patch internals for unit testing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getOrderBook = async () => [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getPositionBook = async () => [
      { stat: 'Ok', token: 'TOKEN1', tsym: 'NIFTY26NOV24500CE', exch: 'NFO', netqty: '50' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getQuotes = async (): Promise<FlattradeQuote> => ({
      stat: 'Ok',
      token: 'TOKEN1',
      lp: '', // Empty LTP — unavailable
    });

    await expect(adapter.exitPosition('TOKEN1', 'CMD_123')).rejects.toThrow(
      /LTP unavailable/
    );
  });

  it('throws when LTP is "0" — NEVER uses a fallback invented price', async () => {
    const adapter = createMockAdapter();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getOrderBook = async () => [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getPositionBook = async () => [
      { stat: 'Ok', token: 'TOKEN1', tsym: 'NIFTY26NOV24500CE', exch: 'NFO', netqty: '50' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getQuotes = async (): Promise<FlattradeQuote> => ({
      stat: 'Ok',
      token: 'TOKEN1',
      lp: '0',
    });

    await expect(adapter.exitPosition('TOKEN1', 'CMD_123')).rejects.toThrow(
      /LTP unavailable|Invalid LTP/
    );
  });

  it('returns FILLED immediately when position already has netQty=0', async () => {
    const adapter = createMockAdapter();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getOrderBook = async () => [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getPositionBook = async () => [
      { stat: 'Ok', token: 'TOKEN1', tsym: 'NIFTY26NOV24500CE', exch: 'NFO', netqty: '0' },
    ];

    const result = await adapter.exitPosition('TOKEN1', 'CMD_123');
    expect(result.status).toBe('FILLED');
  });
});

describe('FlattradeRestAdapter.exitAllPositions Safety', () => {
  it('throws an error listing ALL failures — does not silently swallow them', async () => {
    const adapter = createMockAdapter();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getOrderBook = async () => [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getPositionBook = async () => [
      { stat: 'Ok', token: 'TOKEN1', tsym: 'NIFTY26NOV24500CE', exch: 'NFO', netqty: '25' },
      { stat: 'Ok', token: 'TOKEN2', tsym: 'NIFTY26NOV25000PE', exch: 'NFO', netqty: '50' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).exitPosition = async (token: string) => {
      throw new Error(`LTP unavailable for token ${token}`);
    };

    await expect(adapter.exitAllPositions('CMD_PANIC')).rejects.toThrow(
      /exitAllPositions.*FAILED/
    );
  });

  it('succeeds when all positions exit cleanly', async () => {
    const adapter = createMockAdapter();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getOrderBook = async () => [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getPositionBook = async () => [
      { stat: 'Ok', token: 'TOKEN1', tsym: 'NIFTY26NOV24500CE', exch: 'NFO', netqty: '25' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).exitPosition = async () => ({ orderId: 'ORD_1', status: 'FILLED' });

    await expect(adapter.exitAllPositions('CMD_PANIC')).resolves.toBeUndefined();
  });

  it('succeeds immediately when no open positions exist', async () => {
    const adapter = createMockAdapter();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getOrderBook = async () => [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).getPositionBook = async () => [];

    await expect(adapter.exitAllPositions('CMD_PANIC')).resolves.toBeUndefined();
  });
});
