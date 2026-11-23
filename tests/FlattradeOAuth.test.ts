import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FlattradeOAuthError, FlattradeRestAdapter } from '../src/adapters/broker/FlattradeRestAdapter.js';

const API_KEY = 'TEST_API_KEY';
const API_SECRET = 'TEST_API_SECRET';
const REQUEST_CODE = 'TEST_REQUEST_CODE';
const TOKEN = 'TEST_ACCESS_TOKEN';

describe('Flattrade OAuth token exchange', () => {
  const servers: Server[] = [];
  const adapters: FlattradeRestAdapter[] = [];

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
  });

  async function withResponse<T>(
    httpStatus: number,
    responseBody: string,
    run: (adapter: FlattradeRestAdapter) => Promise<T>
  ): Promise<T> {
    const server = createServer((_request, response) => {
      response.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      response.end(responseBody);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');

    const adapter = new FlattradeRestAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      userId: 'TEST_USER',
      authUrl: `http://127.0.0.1:${address.port}/trade/apitoken`,
    });
    adapters.push(adapter);
    return run(adapter);
  }

  it('accepts the documented status response and returns its token', async () => {
    await withResponse(200, JSON.stringify({ status: 'Ok', token: TOKEN, client: 'TEST_CLIENT', emsg: '' }), async (adapter) => {
      await expect(adapter.exchangeOAuthToken(REQUEST_CODE)).resolves.toBe(TOKEN);
      expect(adapter.getSessionToken()).toBe(TOKEN);
    });
  });

  it('accepts the legacy stat response', async () => {
    await withResponse(200, JSON.stringify({ stat: 'Ok', token: TOKEN }), async (adapter) => {
      await expect(adapter.exchangeOAuthToken(REQUEST_CODE)).resolves.toBe(TOKEN);
    });
  });

  it('rejects an OAuth failure status and sanitizes broker diagnostics', async () => {
    const hash = createHash('sha256').update(API_KEY + REQUEST_CODE + API_SECRET).digest('hex');
    await withResponse(200, JSON.stringify({
      status: 'Not_Ok',
      emsg: `Rejected ${REQUEST_CODE} ${TOKEN} ${API_KEY} ${API_SECRET} ${hash}`,
    }), async (adapter) => {
      const error = await adapter.exchangeOAuthToken(REQUEST_CODE).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FlattradeOAuthError);
      expect(error).toMatchObject({ httpStatus: 200, oauthStatus: 'Not_Ok', stage: 'oauth_exchange' });
      const diagnostic = (error as FlattradeOAuthError).brokerMessage ?? '';
      for (const secret of [REQUEST_CODE, TOKEN, API_KEY, API_SECRET, hash]) {
        expect(diagnostic).not.toContain(secret);
      }
      expect(adapter.getSessionToken()).toBeNull();
    });
  });

  it('rejects a success status without a non-empty token', async () => {
    await withResponse(200, JSON.stringify({ status: 'Ok', token: '  ' }), async (adapter) => {
      await expect(adapter.exchangeOAuthToken(REQUEST_CODE)).rejects.toMatchObject({
        httpStatus: 200,
        oauthStatus: 'Ok',
        stage: 'oauth_exchange',
      });
      expect(adapter.getSessionToken()).toBeNull();
    });
  });

  it('rejects invalid JSON without exposing the response body', async () => {
    await withResponse(200, `invalid ${TOKEN} ${REQUEST_CODE}`, async (adapter) => {
      await expect(adapter.exchangeOAuthToken(REQUEST_CODE)).rejects.toMatchObject({
        httpStatus: 200,
        oauthStatus: null,
        brokerMessage: null,
        stage: 'oauth_exchange',
      });
    });
  });

  it('rejects a non-2xx response even when its body claims OAuth success', async () => {
    await withResponse(401, JSON.stringify({ status: 'Ok', token: TOKEN }), async (adapter) => {
      await expect(adapter.exchangeOAuthToken(REQUEST_CODE)).rejects.toMatchObject({
        httpStatus: 401,
        oauthStatus: 'Ok',
        stage: 'oauth_exchange',
      });
      expect(adapter.getSessionToken()).toBeNull();
    });
  });
});
