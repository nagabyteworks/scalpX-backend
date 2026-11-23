# scalpX Backend

## Purpose

scalpX is a LIVE, single-user index-options trading backend for SENSEX and other configured indices. It owns Flattrade OAuth, market-data subscriptions, broker order submission, stop-loss management, target monitoring, risk controls, and reconciliation. Android is an interface only and contains no broker credentials or trading calculations.

## Authentication

The only application authentication method is a six-digit RFC 6238 TOTP:

1. Android submits `{ "totp": "123456" }` to `POST /api/auth/daily-login`.
2. The backend validates the code using the backend-only `DEVICE_TOTP_SECRET`.
3. The backend atomically consumes the matching time step in SQLite replay state.
4. A short-lived HS256 session JWT is issued.
5. Protected REST and WebSocket endpoints require `Authorization: Bearer <JWT>`.

There is no device UUID, device provisioning, device enrollment, device revocation, or device-bound JWT. Legacy endpoints return 404:

- `/api/auth/provision-device`
- `/api/auth/revoke-device`
- `/api/auth/device/authenticate`

Failed TOTP attempts are rate limited by client IP. Replay, invalid codes, expired sessions, and unauthorized API access are fail closed.

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
- `HttpServer`: authenticated REST API and TOTP login.
- `ClientWsHub`: authenticated Android WebSocket snapshots and priority events.
- `OrderManager`: entry, exit, and broker order lifecycle.
- `RatchetLadderEngine`: RAM/in-memory ratcheting ladder state.
- `ReconcilerService`: startup and recovery reconciliation.
- `SqliteStateStore`: persistent audit, position, risk, session, and replay state.

## Environment

Required live configuration:

- `APP_JWT_SECRET`
- `DEVICE_TOTP_SECRET`
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
