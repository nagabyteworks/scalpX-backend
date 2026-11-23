# Backend Repository Instructions

- Follow the strict architecture and live-trading constraints in the attached project instructions.
- This repository may communicate with Flattrade and execute LIVE orders only when `TRADING_ENABLED=true` after explicit authorization.
- Keep `TRADING_ENABLED=false` for implementation and tests.
- Device authorization, UUID validation, provisioning, and revocation are forbidden.
- The app starts directly; no application TOTP or device authorization mechanism is allowed.
- Protected APIs and WebSockets require a valid bearer session.
- Preserve atomic replay protection and IP rate limiting.
- Preserve integer-paise calculations and protective SL-LMT broker orders.
- Keep trailing targets exclusively in backend RAM.
- Never log broker secrets or broker access tokens.
