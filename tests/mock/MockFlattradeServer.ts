import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { FlattradeOrderBookItem, FlattradePosition } from '../../src/adapters/broker/FlattradeProtocol.js';

export interface MockServerOptions {
  expectedApiKey?: string;
  expectedApiSecretHash?: string;
  sessionToken?: string;
}

export class MockFlattradeServer {
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private activeWsClients: Set<WebSocket> = new Set();

  public orderBook: FlattradeOrderBookItem[] = [];
  public positionBook: FlattradePosition[] = [];
  public orderSequence = 0;
  public receivedRequests: Array<{ url: string; body: string }> = [];

  private port = 0;
  private sessionToken: string;

  constructor(options: MockServerOptions = {}) {
    this.sessionToken = options.sessionToken ?? 'MOCK_SESSION_TOKEN_ABC';

    this.httpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        this.receivedRequests.push({ url: req.url ?? '', body });
        this.handleHttp(req, res, body, options);
      });
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => {
      this.activeWsClients.add(ws);

      ws.on('message', (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          // Connection handshake
          if (parsed.t === 'c') {
            if (parsed.susertoken === this.sessionToken) {
              ws.send(JSON.stringify({ t: 'ck', s: 'OK' }));
            } else {
              ws.send(JSON.stringify({ t: 'ck', s: 'NOT_OK' }));
            }
          }
          // Touchline subscription
          if (parsed.t === 't') {
            ws.send(JSON.stringify({ t: 'tk', stat: 'Ok' }));
          }
        } catch {
          // Ignore
        }
      });

      ws.on('close', () => {
        this.activeWsClients.delete(ws);
      });
    });
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse, body: string, options: MockServerOptions): void {
    const url = req.url ?? '';

    // 1. OAuth apitoken
    if (url.includes('/trade/apitoken')) {
      try {
        const json = JSON.parse(body);
        if (options.expectedApiKey && json.api_key !== options.expectedApiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ stat: 'Not_Ok', emsg: 'Invalid API Key' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stat: 'Ok', token: this.sessionToken }));
        return;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stat: 'Not_Ok', emsg: 'Malformed JSON' }));
        return;
      }
    }

    // Parse form body jData=<JSON>&jKey=<token>
    let jData: Record<string, unknown> = {};
    const params = new URLSearchParams(body);
    const jDataRaw = params.get('jData');
    if (jDataRaw) {
      try {
        jData = JSON.parse(jDataRaw);
      } catch {
        // Ignore
      }
    }

    // 2. PlaceOrder
    if (url.includes('/PlaceOrder')) {
      const prctyp = jData.prctyp as string;
      if (prctyp !== 'LMT' && prctyp !== 'SL-LMT') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stat: 'Not_Ok', emsg: `Disallowed order type: ${prctyp}` }));
        return;
      }

      const ordNo = `FT_ORD_${++this.orderSequence}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stat: 'Ok', norenordno: ordNo, request_time: '11:15:00' }));
      return;
    }

    // 3. ModifyOrder
    if (url.includes('/ModifyOrder')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stat: 'Ok', norenordno: jData.norenordno ?? 'ORD_MODIFIED' }));
      return;
    }

    // 4. CancelOrder
    if (url.includes('/CancelOrder')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stat: 'Ok', result: 'CANCELLED' }));
      return;
    }

    // 5. OrderBook
    if (url.includes('/OrderBook')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.orderBook));
      return;
    }

    // 6. PositionBook
    if (url.includes('/PositionBook')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.positionBook));
      return;
    }

    // 7. GetQuotes
    if (url.includes('/GetQuotes')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stat: 'Ok', token: jData.token ?? '26000', lp: '100.00', bp1: '99.95', sp1: '100.05' }));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  async start(): Promise<{ httpUrl: string; wsUrl: string }> {
    return new Promise((resolve) => {
      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer.address() as AddressInfo;
        this.port = addr.port;
        resolve({
          httpUrl: `http://127.0.0.1:${this.port}`,
          wsUrl: `ws://127.0.0.1:${this.port}`,
        });
      });
    });
  }

  broadcastTick(token: string, lp: string, bp1 = '99.95', sp1 = '100.05'): void {
    const msg = JSON.stringify({
      t: 'tk',
      tk: token,
      lp,
      bp1,
      sp1,
      v: 1000,
    });
    for (const ws of this.activeWsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  broadcastOrderUpdate(norenordno: string, status: string, avgprc?: string): void {
    const msg = JSON.stringify({
      t: 'om',
      norenordno,
      status,
      avgprc,
    });
    for (const ws of this.activeWsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.activeWsClients) {
      try {
        ws.terminate();
      } catch {
        // Ignore
      }
    }
    this.activeWsClients.clear();

    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => resolve());
      });
    });
  }
}
