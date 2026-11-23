import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FlattradeRestAdapter,
  parseFlattradeIndexOptionMaster,
} from '../../src/adapters/broker/FlattradeRestAdapter.js';
import { FLATTRADE_INDEX_CONTRACT_MASTER_URLS } from '../../src/adapters/broker/FlattradeProtocol.js';

const nfoMaster = [
  'Exchange,Token,Lotsize,Symbol,Tradingsymbol,Instrument,Expiry,Strike,Optiontype',
  'NFO,101,65,NIFTY,NIFTY25JUN2027C24000,OPTIDX,25-JUN-2027,24000.00,CE',
  'NFO,102,65,NIFTY,NIFTY25JUN2027P24000,OPTIDX,25-JUN-2027,24000.00,PE',
  'NFO,103,65,NIFTY,NIFTY30JUN2027F,FUTIDX,30-JUN-2027,-0.01,XX',
  'NFO,104,30,BANKNIFTY,BANKNIFTY25JUN2027C50000,OPTIDX,25-JUN-2027,50000.00,CE',
].join('\n');

describe('Flattrade index contract master', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses only valid index option records with broker-provided contract metadata', () => {
    const contracts = parseFlattradeIndexOptionMaster(nfoMaster, 'NFO');

    expect(contracts.get('NIFTY')).toEqual([
      {
        exchange: 'NFO',
        underlyingSymbol: 'NIFTY',
        token: '101',
        symbol: 'NIFTY25JUN2027C24000',
        expiry: '2027-06-25',
        strike: 24_000,
        optionType: 'CE',
        lotSize: 65,
      },
      {
        exchange: 'NFO',
        underlyingSymbol: 'NIFTY',
        token: '102',
        symbol: 'NIFTY25JUN2027P24000',
        expiry: '2027-06-25',
        strike: 24_000,
        optionType: 'PE',
        lotSize: 65,
      },
    ]);
    expect(contracts.has('SENSEX')).toBe(false);
  });

  it('rejects malformed, invalid, or ambiguous option records', () => {
    expect(() => parseFlattradeIndexOptionMaster('not,a,contract,master', 'NFO')).toThrow();
    expect(() => parseFlattradeIndexOptionMaster(
      `${nfoMaster}\nNFO,105,65,NIFTY,NIFTY25JUN2027C24000,OPTIDX,25-JUN-2027,24000.00,CE`,
      'NFO'
    )).toThrow(/ambiguous/i);
    expect(() => parseFlattradeIndexOptionMaster(
      nfoMaster.replace('25-JUN-2027,24000.00,CE', '31-FEB-2027,24000.00,CE'),
      'NFO'
    )).toThrow(/invalid option metadata/i);
  });

  it('fetches the correct Flattrade exchange master and coalesces repeated requests', async () => {
    const fetchMock = vi.fn(async () => new Response(nfoMaster, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new FlattradeRestAdapter({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      userId: 'test-user',
    });

    try {
      const first = await adapter.getIndexOptionContracts('NFO', 'NIFTY');
      const second = await adapter.getIndexOptionContracts('NFO', 'NIFTY');

      expect(first).toHaveLength(2);
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        FLATTRADE_INDEX_CONTRACT_MASTER_URLS.NFO,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    } finally {
      await adapter.close();
    }
  });
});
