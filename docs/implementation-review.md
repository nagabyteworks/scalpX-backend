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

Flattrade's official API documentation lists downloadable scrip-master groups for BSE index derivatives and NFO index derivatives. It does not expose a download URL or file schema in the documentation text available for this review, so no CSV column layout or cache implementation is assumed. The same documentation defines authenticated `GetIndexList` (`uid`, `exch`) and a response containing `idxname` and `token`; this is the authoritative route to resolve a current BSE SENSEX index token dynamically, rather than embedding a token. It can also supply NSE index identifiers. Expiry, strike, trading symbol, token, and lot size for option contracts must come from the official master/API data; ATM strike spacing must be derived from valid contracts in the selected expiry, not fixed in code. The next market-data milestone is to obtain/confirm the official BFO/NFO master download links and schemas, then implement an atomic daily cache and strict parser with fixture rows from those published files. Until then, live contracts remain unavailable.

## Authentication documentation review

The official [Flattrade Pi API documentation](https://pi.flattrade.in/docs) specifies `/Limits` as a POST API using `jData` plus `jKey`, lists `uid`/`actid` request fields, and documents `stat: "Ok"` success and `stat: "Not_Ok"` with `Session Expired : Invalid Session Key` on failure. The adapter sends those fields, treats explicit expired-key responses as invalid, and maps transport or unclassified responses to unknown. This is a read-only validation call and matches the documented response contract.

Flattrade's documented login flow says authentication is initiated in a browser at `https://auth.flattrade.in/?app_key=...`, where the user authorizes with client ID, password, and PAN/year of birth, and Flattrade redirects to the registered callback with `request_code`. The docs describe a 24-hour access token cleared between 5–6 AM. They do not document direct TOTP login, `/auth/session`, `/ftauth`, or `/trade/apitoken` as public Pi API endpoints. The current direct OTP implementation must therefore be treated as unsupported and must not be the production login path; the documented OAuth callback is retained. A follow-up should remove the undocumented daily-login route and Android OTP entry flow, then confirm the browser redirect/callback end to end.

## Deployment configuration

The deploy script now targets `/opt/scalpx`, checks the configured systemd working directory, verifies `/etc/scalpx/env` is readable and `/var/lib/scalpx` is writable before syncing, and refuses to proceed without an explicit `EC2_HOST`. Rsync excludes environment files, SQLite database/journal files, logs, and the data directory from deletion or replacement. After the restart it polls `/health/live` and confirms the systemd unit is active. These checks only run if a maintainer explicitly invokes the deployment script; no EC2 deployment was run for this review.

## Test status

Existing regression coverage exercises valid and expired stored sessions through `/Limits`, fresh per-token tick readiness, stale-feed reconnect, BFO/NFO subscriptions and resubscriptions, broker WebSocket auth rejection, live auth state transitions, unavailable LIVE instrument data, paper-mode empty contracts, and no paper quote fallback. A deployment configuration test checks the systemd/deploy path agreement, persistent-data exclusions, explicit-host guard, preflight paths, and liveness polling without invoking deployment.

Production credentials, EC2, and execution enablement were not touched. Current run evidence for this review is reported in the completion summary; prior test results above were from the previous review and are not evidence of the current tree.
