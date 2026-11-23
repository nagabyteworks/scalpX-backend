# Implementation Review

## Application startup and authentication

Device pre-authorization and TOTP authentication were removed from both repositories.
The Android app starts directly in the trading cockpit.
Flattrade authentication remains a separate browser-OAuth flow and does not require application TOTP.
No device UUID or application bearer session is created or transmitted.

## Security and migration behavior

Startup migration drops legacy `authorized_devices` and `totp_replay_state` tables. Broker session tokens and secrets are redacted in application logging.

## Trading state

The backend retains live trading state and broker integration. It must keep `TRADING_ENABLED=false` during implementation and testing. The protective stop-loss is broker-side `SL-LMT`; trailing targets are backend RAM-only and are not persisted or sent to Flattrade.

Backend startup reconciles broker positions and preserves unknown state as manual intervention rather than guessing target state.

## Verification

Required verification includes direct startup, Flattrade OAuth, fresh spot resolution, option-chain contract resolution, live LTP updates, reconnection/resubscription, stale feed handling, order lifecycle, SL lifecycle, restart reconciliation, backend tests, Android tests, type checks, and builds.
