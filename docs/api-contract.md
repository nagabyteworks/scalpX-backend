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

The backend resolves index tokens with Flattrade `GetIndexList`. It resolves
option contracts from Flattrade's daily index-derivatives Scrip Master:

- NFO: `https://flattrade.s3.ap-south-1.amazonaws.com/scripmaster/Nfo_Index_Derivatives.csv`
- BFO: `https://flattrade.s3.ap-south-1.amazonaws.com/scripmaster/Bfo_Index_Derivatives.csv`

The backend validates the master header and each index-option row, then uses its
`Exchange`, `Token`, `Lotsize`, `Symbol`, `Tradingsymbol`, `Instrument`,
`Expiry`, `Strike`, and `Optiontype` columns. It accepts only the requested
exchange, exact index symbol, `OPTIDX`, positive numeric tokens/strikes/lot
sizes, valid exchange-local contract dates, and CE/PE option types. This keeps
symbols, expiries, tokens, strikes and lot sizes broker-sourced rather than
constructed or hardcoded. Successfully parsed files are cached in memory for up
to 15 minutes; failed downloads or malformed masters do not fall back to stale
or fabricated contracts.

The backend intentionally does not pass a bare index name to Flattrade
`GetOptionChain`: the published Flattrade Python API documents that endpoint's
`tradingsymbol` as the symbol of an existing option or future contract. The Scrip
Master provides both the authoritative contract list and expiry metadata the
client needs. See [Flattrade's API documentation](https://github.com/flattrade/pythonAPI/blob/main/README.md#md-get_optionchain)
and the linked master files above.

The index-list parser accepts numeric and numeric-string tokens, normalizes
names, retains a broker-returned exchange when present (otherwise the queried
exchange), and rejects exchange mismatches. NIFTY matches only
`NIFTY` or the documented `Nifty 50` alias on NSE; SENSEX matches only `SENSEX`
on BSE. Ambiguous, missing, invalid-token and wrong-exchange results fail
explicitly. `/api/option-chain` defaults to the nearest future expiry with
complete CE/PE pairs, then chooses the paired strike nearest the fresh spot
price. An explicit expiry must be available in the current master. The `strikes`
query parameter controls the returned paired strike window (maximum 25 on each
side of ATM). The backend subscribes only to the index and returned contracts.
The response includes `dataSource`, `marketDataReady`, available `expiries`,
verified contract metadata, and a validation description.

After subscribing, the backend waits asynchronously for a fresh first tick
instead of reading the cache immediately. `MARKET_DATA_INITIAL_TICK_TIMEOUT_MS`
configures that wait (default 5000 ms, allowed range 250–30000 ms). The spot
endpoint waits for its index tick; the option-chain endpoint also waits for the
selected ATM CE and PE ticks. Missing tokens, unavailable/invalid contract
masters, incomplete pairs, and unavailable or stale ticks produce a structured
error with a stable `error.code` and explanatory `error.message`; they are not
replaced with sample values.
Readiness is derived from session validity, WebSocket transport/authentication,
resolved contracts, and fresh ticks. `/health/live` reports process liveness;
`/health/ready` returns 503 while required LIVE market dependencies are not ready.

Examples of market-data error codes include `BROKER_SESSION_UNAVAILABLE`,
`INDEX_NOT_FOUND`, `INVALID_INDEX_TOKEN`, `AMBIGUOUS_INDEX`,
`CONTRACT_MASTER_UNAVAILABLE`, `INVALID_CONTRACT_MASTER`,
`OPTION_CONTRACTS_NOT_FOUND`, `EXPIRY_UNAVAILABLE`,
`WEBSOCKET_NOT_CONNECTED`, `SUBSCRIPTION_REJECTED`, and
`INITIAL_TICK_NOT_RECEIVED`. Responses and logs never include credentials,
OAuth codes, or broker session tokens.

The broker WebSocket authenticates with `t: "a"` and recognizes the documented
`t: "ak"` acknowledgement. Touchline subscription acknowledgements use `t: "tk"`
and feed updates use `t: "tf"`. Duplicate subscriptions are suppressed, active
subscriptions are restored after reconnect, and a rejected broker session does
not trigger an endless reconnect loop.

### `/ws` snapshot

The backend sends a `SNAPSHOT` immediately on connection and coalesces subsequent
position and market-data changes every 150 ms. `marketData` is `null` until
contracts have been selected. Stale or unavailable prices and timestamps are
`null`; `feedStatus` describes the broker feed. The values in angle brackets
below are schema placeholders, not live or fabricated broker data.

```json
{
  "type": "SNAPSHOT",
  "timestamp": 1795410129998,
  "openPositionsCount": 0,
  "positions": [],
  "marketData": {
    "indexSymbol": "SENSEX",
    "spotExchange": "BSE",
    "spotToken": "<GetIndexList token>",
    "spotLtpPaise": null,
    "spotTimestamp": null,
    "selectedExpiry": "<contract-master expiry>",
    "atmStrike": "<nearest listed strike>",
    "ceSymbol": "<contract-master CE trading symbol>",
    "ceToken": "<contract-master CE token>",
    "ceLotSize": "<contract-master CE lot size>",
    "ceLtpPaise": null,
    "ceTimestamp": null,
    "peSymbol": "<contract-master PE trading symbol>",
    "peToken": "<contract-master PE token>",
    "peLotSize": "<contract-master PE lot size>",
    "peLtpPaise": null,
    "peTimestamp": null,
    "marketDataTimestamp": null,
    "marketDataReady": false,
    "feedStatus": "WAITING_FOR_TICK",
    "strikes": [
      {
        "strikePrice": "<listed strike>",
        "ceToken": "<contract-master CE token>",
        "ceLotSize": "<contract-master CE lot size>",
        "ceSymbol": "<contract-master CE trading symbol>",
        "ceLtpPaise": null,
        "ceTimestamp": null,
        "peToken": "<contract-master PE token>",
        "peLotSize": "<contract-master PE lot size>",
        "peSymbol": "<contract-master PE trading symbol>",
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
