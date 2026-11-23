# scalpX Backend API Contract

## Direct application access

The Android app does not require TOTP, device provisioning, a device UUID, or an application bearer session.
REST market-data and control APIs are opened for the direct trading interface.

## Broker authorization

- `GET /api/auth/login-url`
- `GET /api/auth/flattrade/callback`
- `GET /api/auth/status`

Broker OAuth is independent of application startup. Android must never receive broker credentials or Flattrade session tokens.

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
- Application/device secrets and broker session tokens are redacted from logs.
- `BROKER_MODE=live`.
- `TRADING_ENABLED=false` unless explicitly approved.
- Protected endpoints never bypass session validation.
