# scalpX API Contract

scalpX is a backend-authoritative LIVE-only trading application. Android communicates only with this API and never receives broker credentials, the TOTP secret, or Flattrade session tokens. Production base URL is `https://trade.nagabyte.com`; the configured Android build environment supplies the base URL and users cannot edit it.

All authenticated routes require `Authorization: Bearer <access-token>` and `X-Device-Id: <persistent UUID>`. The JWT device claim must match the header and the device must remain authorized and unrevoked. Amounts are integer paise (`110.05` is `11005`).

## Device authentication

An administrator authorizes a device in advance using `POST /api/auth/provision-device` with `X-Device-Id` and `{ "enrollmentSecret": "…", "deviceName": "…" }`. This route registers the device only; it does not issue an access token. `DEVICE_ENROLLMENT_SECRET` is backend-only.

The authorized device authenticates with:

`POST /api/auth/device/authenticate`

```json
{
  "deviceId": "persistent-device-uuid",
  "totp": "123456",
  "deviceName": "Owner Android Phone"
}
```

Success returns `{ "success": true, "accessToken": "…", "expiresIn": 900, "device": { "id": "…", "status": "AUTHORIZED" } }`. A missing backend TOTP secret returns 503; invalid codes or unauthorized/revoked devices are rejected. Authentication is rate limited, TOTP is never logged, and accepted time steps cannot be replayed. The backend owns `DEVICE_TOTP_SECRET`; Android stores the access token in Keystore-backed encrypted preferences. Device revocation is available to an authenticated owner through `POST /api/auth/revoke-device`.

## Flattrade browser authorization

`GET /api/auth/login-url` requires device authentication and returns the documented Flattrade browser authorization URL. Open it in the system browser and let Flattrade redirect to the registered callback:

`GET /api/auth/flattrade/callback?request_code=<short-lived code>`

The backend exchanges the request code, encrypts the daily session token in SQLite, validates it using Flattrade `/Limits`, and connects the market feed. The legacy callback alias `/auth/flattrade/callback` is retained. Do not submit the user’s TOTP to Flattrade through scalpX. `/auth/session` and `/ftauth` are not supported. See the [official Flattrade Pi API docs](https://pi.flattrade.in/docs).

## Health and backend configuration

- `GET /health/live` is a process liveness check and returns 200 while the process responds.
- `GET /health/ready` returns 503 until broker session, WebSocket transport/authentication, authoritative instrument master, fresh spot and option quotes, account reconciliation, and execution prerequisites are met. It always reports `tradingReady: false` while execution is disabled.
- `GET /health` returns non-secret operational status and uptime.
- `GET /api/app/config` is authenticated and returns the backend’s environment, trading gate, broker/feed/device status, and feature availability. It never returns secrets.
- `GET /api/auth/status` reports session validity (`VALID`, `INVALID`, or `UNKNOWN`), WebSocket transport and broker authentication, and feed freshness separately.
- `GET /api/market-data/sensex` returns the dynamically resolved BSE SENSEX token, exchange, live spot LTP/timestamp when fresh, and a readiness status. It does not return a fallback price.

## Market data and order entry availability

`GET /api/option-chain?symbol=SENSEX&strikes=10` returns 503 until an official BFO scrip-master download URL and schema can be verified and the backend can validate expiry, CE/PE contracts, and fresh quotes. It never returns an empty simulated chain or invented tokens.

`POST /api/orders/one-click` is gated by server-side `TRADING_ENABLED` and authoritative contract/quote validation. Production keeps `TRADING_ENABLED=false`, so the backend rejects new entries. Even with that flag enabled, the current implementation returns 503 until verified BFO instrument validation and fresh quote readiness exist. No mock order execution is present in production code. Emergency exit endpoints remain available for reconciled existing positions.

## Environment and deployment

Backend-only variables include `BROKER_MODE=live`, `TRADING_ENABLED=false`, `APP_JWT_SECRET`, `DEVICE_ENROLLMENT_SECRET`, `DEVICE_TOTP_SECRET`, `FLATTRADE_USER_ID`, `FLATTRADE_API_KEY`, `FLATTRADE_API_SECRET`, `FLATTRADE_REDIRECT_URL`, `DB_SESSION_ENCRYPTION_KEY`, and `DB_PATH`. Only `BROKER_MODE=live` is accepted. Local development loads them from ignored `.env`; production loads `/etc/scalpx/env`. The SQLite database and Flattrade access token remain on the backend.

The Android base URL comes from the build environment, not a user preference. Deployment targets `/opt/scalpx`, reads `/etc/scalpx/env`, and preserves `/var/lib/scalpx`; the reviewed deploy script makes a code backup and restores it on failure. Do not run it without explicit production authorization.
