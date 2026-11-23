# scalpX Backend API Contract

## Authentication

`POST /api/auth/daily-login`

Request:

```json
{ "totp": "123456" }
```

Success `200`:

```json
{ "status": "ok", "accessToken": "<HS256 JWT>", "expiresIn": 900 }
```

Errors:

- `400`: malformed TOTP
- `401`: invalid or replayed TOTP
- `429`: five-minute authentication lockout
- `503`: backend TOTP secret unavailable

All authenticated requests use only:

```text
Authorization: Bearer <access-token>
```

WebSocket connections use the same bearer token in the upgrade `Authorization` header. Device headers, claims, provisioning, and revocation do not exist.

Legacy routes `/api/auth/provision-device`, `/api/auth/revoke-device`, and `/api/auth/device/authenticate` return `404`.

## Broker authorization

- `GET /api/auth/login-url`
- `GET /api/auth/flattrade/callback`
- `GET /api/auth/status`

Broker OAuth is independent of application TOTP authentication. Android must never receive broker credentials or Flattrade session tokens.

## Market data

- `GET /api/market-data/sensex`
- `GET /api/option-chain`
- `GET /api/app/config`

Market snapshots and live option ticks are provided through the backend WebSocket `/ws`. The backend owns index resolution, instrument-master expiry resolution, ATM resolution, subscriptions, reconnect, resubscribe, stale-data detection, and market closure handling.

## Orders and positions

- `POST /api/orders/one-click`
- `PATCH /api/ladders/{token}`
- `POST /api/orders/exit-position`
- `POST /api/orders/exit-all`
- `GET /api/trades/today`

Every mutating request includes a UUID `commandId`. Entry and exit operations are backend owned. Android submits symbols, quantities, order types, and risk distances only; it never places a Flattrade order.

The initial and subsequent protective orders are broker-side `SL-LMT` orders. Backend targets are delivered in position snapshots but are exclusively RAM state and are never accepted as broker orders.

## Security and live-trading invariants

- HTTPS is mandatory.
- TOTP codes, bearer sessions, secrets, and broker session tokens are redacted from logs.
- TOTP replay is protected atomically per accepted time step.
- `BROKER_MODE=live`.
- `TRADING_ENABLED=false` unless explicitly approved.
- Protected endpoints never bypass session validation.
