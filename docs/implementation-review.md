# scalpX Implementation Review

## Project purpose

scalpX is a single-user options trading cockpit. The Android app is a thin client for viewing state and sending explicit actions. The Node.js backend owns authentication, broker connectivity, market data, risk checks, order submission, position reconciliation, and the ratcheting stop-loss engine. LIVE operation depends on Flattrade Pi API v2; PAPER operation is a simulator and must never be presented as exchange data.

## Changes in this review

- `/api/auth/status` now reports session validity, WebSocket transport, broker WebSocket authentication, and fresh market-data readiness independently. A token in SQLite does not prove connectivity. `FEED_READY` requires a fresh tick for every subscribed token; disconnected and reconnecting states cannot report authenticated or ready.
- LIVE session validity is checked against the current trade-date token and Flattrade's documented, read-only [`/Limits` API](https://pi.flattrade.in/docs), cached for 15 seconds. An unavailable broker response is reported as `UNKNOWN`, while Flattrade's explicit expired/invalid-session response is `INVALID`.
- Broker subscriptions now require `EXCHANGE|TOKEN` keys. Positions preserve exchange in SQLite and reconnection uses the same qualified instrument ID.
- Flattrade `ck: NOT_OK` now rejects the pending WebSocket connection instead of leaving the login request unresolved. Feed freshness is cleared on disconnect and re-evaluated after reconnection.
- Paper quotes require a simulated tick. The adapter no longer invents a default LTP or a SENSEX/NIFTY option chain, expiry, token, trading symbol, or option LTP.
- LIVE option-chain requests and order entries fail closed until the service has authoritative instrument-master validation and a fresh underlying quote. LIVE entry order validation therefore cannot accept paper-mode or unverified token/symbol/expiry/lot-size metadata.
- LIVE order placement also requires a successful positive quote. Missing or invalid LTP is never replaced by a default price.
- Android clears old index contracts on index changes or option-chain request failures and uses only a backend-provided ATM strike with both CE and PE tokens.

## Flattrade data limitation

The project currently has no instrument-master download, parser, cache, or SENSEX index-token configuration. It therefore cannot verify an authoritative SENSEX spot stream or establish the spot → backend → Android data path. Flattrade's published API client describes `GetOptionChain` as taking a tradable option/future symbol and an underlying midpoint; this project previously sent bare `SENSEX` and `0`, which cannot establish a valid spot-centered chain. Until a documented master source and validated index token are configured, the backend returns no LIVE chain or ATM and rejects LIVE entries. No undocumented endpoint or synthetic spot data was added.

## Test status

- Backend: `npm test` — 110 tests passed across 18 files, including localhost HTTP/WebSocket binding; `npm run typecheck` passed.
- Android: `./gradlew testDebugUnitTest assembleDebug` passed, including 31 unit tests and debug APK assembly.

Tests cover valid and expired stored sessions through `/Limits`, fresh per-token tick readiness, stale-feed reconnect, BFO/NFO subscriptions and resubscriptions, broker WebSocket auth rejection, live auth state transitions, unavailable LIVE instrument data, paper-mode empty contracts, and no paper quote fallback. Production credentials, EC2, and execution enablement were not touched.
