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
- `GET /api/market-data/index?symbol=SENSEX|NIFTY`
- `GET /api/option-chain`
- `GET /api/app/config`

The backend resolves index tokens with Flattrade `GetIndexList`; option contracts,
expiries, symbols, tokens and lot sizes come from Flattrade `GetOptionChain`.
`/api/option-chain` defaults to the nearest future expiry with complete CE/PE
pairs, then chooses the paired strike nearest the fresh spot price. An explicit
expiry may be selected if it is among the returned future expiries. The backend
subscribes to the index token and the selected-expiry option contracts. The
option-chain response includes `dataSource`, `marketDataReady`, and a validation
description to make the source of its contracts and price readiness explicit.

The spot and option REST responses report live prices only when the corresponding
authenticated WebSocket tick is no more than 3 seconds old. Missing tokens,
unsupported broker operations, incomplete contracts, and unavailable or stale
ticks produce a specific error/status; they are not replaced with sample values.
Readiness is derived from session validity, WebSocket transport/authentication,
resolved contracts, and fresh ticks. `/health/live` reports process liveness;
`/health/ready` returns 503 while required LIVE market dependencies are not ready.

### `/ws` snapshot

The backend sends a `SNAPSHOT` immediately on connection and coalesces subsequent
position and market-data changes every 150 ms. `marketData` is `null` until
contracts have been selected. Stale or unavailable prices and timestamps are
`null`; `feedStatus` describes the broker feed.

```json
{
  "type": "SNAPSHOT",
  "timestamp": 1795410129998,
  "openPositionsCount": 0,
  "positions": [],
  "marketData": {
    "indexSymbol": "SENSEX",
    "spotToken": "<GetIndexList token>",
    "spotLtpPaise": null,
    "spotTimestamp": null,
    "selectedExpiry": "2026-11-26",
    "atmStrike": 82000,
    "ceSymbol": "<GetOptionChain CE symbol>",
    "ceToken": "<GetOptionChain CE token>",
    "ceLotSize": 20,
    "ceLtpPaise": null,
    "ceTimestamp": null,
    "peSymbol": "<GetOptionChain PE symbol>",
    "peToken": "<GetOptionChain PE token>",
    "peLotSize": 20,
    "peLtpPaise": null,
    "peTimestamp": null,
    "marketDataTimestamp": null,
    "feedStatus": "WAITING_FOR_TICK",
    "strikes": [
      {
        "strikePrice": 82000,
        "ceToken": "<GetOptionChain CE token>",
        "ceLotSize": 20,
        "ceSymbol": "<GetOptionChain CE symbol>",
        "ceLtpPaise": null,
        "ceTimestamp": null,
        "peToken": "<GetOptionChain PE token>",
        "peLotSize": 20,
        "peSymbol": "<GetOptionChain PE symbol>",
        "peLtpPaise": null,
        "peTimestamp": null
      }
    ]
  }
}
```

`feedStatus` is `CONNECTED`, `DISCONNECTED`, `RECONNECTING`, `STALE`, or
`WAITING_FOR_TICK`. Per-contract timestamps describe the last fresh tick, not
the snapshot's broadcast time.

## Orders and positions

- `POST /api/orders/one-click`
- `PATCH /api/ladders/{token}`
- `POST /api/orders/exit-position`
- `POST /api/orders/exit-all`
- `GET /api/trades/today`

Every mutating request includes a UUID `commandId`. For a one-click entry, the
backend verifies that the exchange-qualified token and trading symbol match a
contract resolved from the current Flattrade option chain, that the lot size
matches broker metadata, and that the contract has a fresh authenticated
WebSocket tick. New entries are rejected while `TRADING_ENABLED=false`, the
broker session/feed is unavailable, or account state is uncertain. Android
submits an order intent; it never places a Flattrade order.

The initial and subsequent protective orders are broker-side `SL-LMT` orders. Backend targets are delivered in position snapshots but are exclusively RAM state and are never accepted as broker orders.

## Security and live-trading invariants

- HTTPS is mandatory.
- Application/device secrets and broker session tokens are redacted from logs.
- `BROKER_MODE=live`.
- `TRADING_ENABLED=false` unless explicitly approved.
- Protected endpoints never bypass session validation.
