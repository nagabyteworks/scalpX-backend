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
- `ClientWsHub`: authenticated Android WebSocket snapshots and priority events.
- `OrderManager`: entry, exit, and broker order lifecycle.
- `RatchetLadderEngine`: RAM/in-memory ratcheting ladder state.
- `ReconcilerService`: startup and recovery reconciliation.
- `SqliteStateStore`: persistent audit, position, risk, session, and replay state.

## Environment

Required live configuration:

- `FLATTRADE_USER_ID`
- `FLATTRADE_API_KEY`
- `FLATTRADE_API_SECRET`
- `FLATTRADE_REDIRECT_URL`
- `DB_SESSION_ENCRYPTION_KEY`
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
