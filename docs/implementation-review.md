# Implementation Review

## Authentication architecture

Device pre-authorization has been removed completely. The backend no longer creates, reads, or migrates `authorized_devices`, and provisioning/revoke/device-authenticate routes do not exist. The Android app does not generate or store a UUID.

The application session flow is TOTP only:

1. `POST /api/auth/daily-login` accepts exactly six digits.
2. `DEVICE_TOTP_SECRET` remains backend-only.
3. RFC 6238 verification uses a ±1 step window.
4. Accepted steps are committed atomically through `totp_replay_state.last_step`.
5. Repeated or older steps are rejected.
6. Five failures trigger a five-minute IP lockout.
7. A 15-minute HS256 bearer session is issued.
8. REST and WebSocket authentication require the bearer session only.

## Security and migration behavior

Startup migration drops the legacy `authorized_devices` table and creates atomic TOTP replay state. TOTP codes and bearer tokens are redacted in application logging. Protected routes fail closed without a valid JWT.

## Trading state

The backend retains live trading state and broker integration. It must keep `TRADING_ENABLED=false` during implementation and testing. The protective stop-loss is broker-side `SL-LMT`; trailing targets are backend RAM-only and are not persisted or sent to Flattrade.

Backend startup reconciles broker positions and preserves unknown state as manual intervention rather than guessing target state.

## Verification

Required verification includes TOTP success, replay, invalid input, rate limiting, session expiration, unauthorized API access, market-data stale handling, order lifecycle, SL lifecycle, restart reconciliation, backend tests, Android tests, type checks, and builds.
