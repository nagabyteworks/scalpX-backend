# scalpX Backend

## Purpose

scalpX is a LIVE, single-user index-options trading backend for SENSEX and other configured indices. It owns Flattrade OAuth, market-data subscriptions, broker order submission, stop-loss management, target monitoring, risk controls, and reconciliation. Android is an interface only and contains no broker credentials or trading calculations.

## Authentication and broker access

The Android app starts directly and requires no application TOTP or device-authorization login.

Device UUIDs, TOTP validation, provisioning, revocation, and application JWT authentication are removed.
Flattrade OAuth remains a separate broker-session flow:

1. Android calls `GET /api/auth/login-url`.
2. It opens the official Flattrade browser authorization URL.
3. The backend exchanges the callback request code for the broker session.
4. The backend validates and connects the Flattrade market-data WebSocket.

## Trading and risk invariants

- LIVE mode only; paper and simulation modes are unsupported.
- `TRADING_ENABLED=false` remains the default and blocks new entry orders.
- Broker communication is isolated in the backend.
- Flattrade credentials and access tokens remain on the backend.
- Prices are represented in integer paise.
- Initial and ratcheted protective stop-losses use Flattrade `SL-LMT` orders.
- The trailing target remains in backend RAM only and is never submitted to the broker.
- No target order is created at Flattrade.
- Partial fills, order rejections, stale feeds, duplicate commands, and account uncertainty are reconciled safely.

## Core services

- `SessionService`: Flattrade broker session validation and OAuth callback handling.
- `HttpServer`: REST API and direct Android integration.
- `ClientWsHub`: direct Android WebSocket snapshots and priority events.
- `OrderManager`: entry, exit, and broker order lifecycle.
- `RatchetLadderEngine`: RAM/in-memory ratcheting ladder state.
- `ReconcilerService`: startup and recovery reconciliation.
- `SqliteStateStore`: persistent audit, position, risk, session, and replay state.

## Local macOS development

The backend is a Node.js/TypeScript service. Its `package.json` scripts build
with `npm run build` and start the compiled server with `npm start`; the default
listener is `127.0.0.1:3000`, with `TRADING_ENABLED=false`. Android Emulator
accesses this host through `http://10.0.2.2:3000`. Use Node.js 20 or newer, as
required by `package.json`.

Create a private local environment file and populate the required backend-only
Flattrade credentials and encryption key:

```bash
cp -n .env.example .env
npm install
npm run build
npm start
```

`.env` is ignored by git. The example lists the complete environment contract
and uses empty secret fields so placeholder credentials cannot be mistaken for
working values. `loadConfig()` requires valid Flattrade credentials and a
64-character session encryption key before startup. Do not copy production
environment files into this repository or into Android. The backend logs its
bind host, port, and trading-enabled state at startup but never prints
credentials.

To reach the development server from a physical phone on the same trusted
Wi-Fi, set `HOST=0.0.0.0` in the local `.env`, build Android with
`DEV_SERVER_URL=http://<mac-lan-ip>:3000`, and allow incoming Node connections
in the macOS firewall. Keep the phone on the same LAN, disable Wi-Fi client
isolation if enabled, and do not forward port 3000 from the router or expose it
to the public internet. Restore `HOST=127.0.0.1` after device testing.

## Live market-data flow

The backend is the only Flattrade market-data client. After OAuth, `SessionService`
validates the saved Flattrade session and the broker WebSocket authenticates with
that session using the Pi WebSocket `ak` acknowledgement. The backend resolves
index tokens using Flattrade `GetIndexList`; it accepts numeric or numeric-string
tokens, normalizes index names, and requires an unambiguous exact alias on the
requested exchange (`NIFTY`/`NIFTY 50` on NSE and `SENSEX` on BSE). It does not
contain guessed index or option tokens.

The index request follows Flattrade's documented `POST /GetIndexList`
contract: `jData` contains the logged-in `uid` and `NSE`/`BSE` exchange, and
the current session token is sent separately as form-encoded `jKey`. The
backend checks the HTTP response, JSON object, `stat`, and `values` array
without converting an empty list into a success-shaped price. On failures it
logs sanitized broker status/message, endpoint, exchange, HTTP status, duration,
token-presence flag, and independently validated session state (`VALID`,
`INVALID`, or `UNKNOWN`). `/Limits` is read-only and is used before assigning
an invalid-session error; an unknown validation result remains unknown. Bodies,
credentials, OAuth codes, TOTP and tokens are never logged, and detailed
diagnostics are not exposed in the public API response. See the [API contract](docs/api-contract.md)
and [Flattrade GetIndexList documentation](https://github.com/marketcalls/broker-api-docs/blob/master/flattrade-api-docs/06-market-info.md#get-index-list).

Android requests `/api/market-data/index?symbol=SENSEX` (or `NIFTY`). The backend
subscribes to the resolved index instrument and waits for the first fresh tick
using an event-driven waiter. The timeout is controlled by
`MARKET_DATA_INITIAL_TICK_TIMEOUT_MS` (default 5000 ms, 250–30000 ms). The endpoint
returns structured errors rather than collapsing broker/session, instrument,
WebSocket, subscription, and tick-timeout failures into a generic response. Once
the spot tick is fresh, Android requests `/api/option-chain`. The backend fetches contracts through Flattrade
index-derivatives Scrip Master (`Nfo_Index_Derivatives.csv` for NFO or
`Bfo_Index_Derivatives.csv` for BFO). The master is an official Flattrade source
of current exchange tokens, underlying names, contract symbols, instrument
types, expiries, strikes, option types and lot sizes. The backend filters the
exact index underlying, keeps only valid `OPTIDX` CE/PE records, and selects the
nearest future expiry containing complete call/put pairs. It calculates ATM
from the complete strike list, returns a bounded window of actual paired
contracts, subscribes only to those instruments, and waits for fresh WebSocket
ticks on the selected ATM CE and PE. The source is cached in memory for at most
15 minutes and is refreshed after expiry; an unavailable or invalid master
produces an explicit error rather than a fallback.

The backend deliberately does not call `GetOptionChain` with a bare index
display name. Flattrade documents that endpoint's `tradingsymbol` as the symbol
of an existing option or future contract; the contract master avoids guessing
that symbol and also supplies the complete expiry/strike metadata required by
the app. See [Flattrade's Python API documentation](https://github.com/flattrade/pythonAPI/blob/main/README.md#md-get_optionchain)
and the [NFO](https://flattrade.s3.ap-south-1.amazonaws.com/scripmaster/Nfo_Index_Derivatives.csv)
and [BFO](https://flattrade.s3.ap-south-1.amazonaws.com/scripmaster/Bfo_Index_Derivatives.csv)
masters.

After selection, `/ws` sends an initial position and market-data snapshot, then
coalesces updates at 150 ms. Each spot and option price includes its tick
timestamp; stale prices are `null`. A broker reconnect restores remembered
subscriptions, and snapshots resume with the new feed state. The broker adapter
deduplicates subscriptions, recognizes `ak` auth acknowledgements, `tk` touchline
acknowledgements, and `tf` updates, and stops reconnecting after the broker rejects
the current session. The Android app
uses the timestamps and feed status to prevent entries against stale prices.
See [API contract](docs/api-contract.md) for the WebSocket shape and readiness
states.

## One-click order entry

The Buy and Sell controls submit directly without a toggle or confirmation
dialog. `POST /api/orders/one-click` accepts only a contract returned by the
current Flattrade option-chain resolution, with matching exchange, symbol and
lot size. The backend also requires a valid broker session, authenticated feed,
a fresh tick for that contract, valid order direction and a protected-entry
ladder configuration. It routes the order through `OrderManager`, which applies
the existing risk checks, command de-duplication, entry and protective
`SL-LMT` lifecycle. `TRADING_ENABLED=false` remains an independent server-side
kill switch and rejects new entries before broker order placement.

## Environment

Required live configuration:

- `FLATTRADE_USER_ID`
- `FLATTRADE_API_KEY`
- `FLATTRADE_API_SECRET`
- `FLATTRADE_REDIRECT_URL`
- `DB_SESSION_ENCRYPTION_KEY`
- `MARKET_DATA_INITIAL_TICK_TIMEOUT_MS` (optional; defaults to 5000 ms, valid range 250–30000)
- `TRADING_ENABLED=false`
- `BROKER_MODE=live`

Never set `TRADING_ENABLED=true` or add paper-trading behavior without explicit authorization.

## API and operations

See [API contract](docs/api-contract.md) and the OpenAPI specifications in `docs/swagger.json`/`docs/swagger.yaml`.

Run:

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```
