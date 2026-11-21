# Backend Rules: Personal One-Click Options & Ratcheting SL Engine

## 1. Runtime & Architecture
- **Target Host:** AWS EC2 `t4g.micro` (Ubuntu 24.04 ARM64, 1 GB RAM, Mumbai `ap-south-1`, permanent Elastic IPv4, auto-started Mon–Fri 8:45 AM–4:00 PM IST).
- **Architecture:** Hexagonal (Ports & Adapters) Modular Monolith in a single Node.js process.
- **Stack:** Node.js 26 LTS, TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), Fastify v5, `ws`, `better-sqlite3` (WAL mode), `undici` HTTP keep-alive pool, Zod/TypeBox validation.
- **Forbidden:** No Docker, no ORMs (Prisma/TypeORM), no external DB/cache daemons (MongoDB/Redis/Postgres) on the VM. Runtime RSS must stay under 150 MB.

## 2. Hard Flattrade API v2 Rules (Non-Negotiable)
- **Base URL:** `https://piconnect.flattrade.in/PiConnectAPI` | **Auth Token URL:** `https://authapi.flattrade.in/trade/apitoken`.
- **Allowed Order Types:** Strictly `LMT` and `SL-LMT` only. NEVER send `MKT`, `SL-MKT`, Cover (`CO`), or Bracket (`BO`) orders.
- **Payload Format:** Form-encoded `jData=<JSON>&jKey=<sessionToken>`, `ordersource: "API"`, and URL-encoded `tsym` on every REST call.
- **Marketable Limit Orders:** Every "1-click market" buy/sell must be converted to a `LMT` order priced slightly across the spread using live LTP/depth + configurable buffer, rounded to `0.05` tick size.
- **Rate Limit:** Strictly under 10 orders/second. Enforce a client-side priority token bucket capped at **6 order/modify calls per second** where `EXIT_ALL` preempts routine `SL-LMT` ratchet updates.
- **Static IP & Secrets:** Daily OAuth token exchange and all order calls run strictly from this server. Never log `api_secret` or raw `jKey` session tokens.
- **Single-User Daily OTP Login Rules:**
  - **Primary Daily Auth Flow (Server-Side 3-Step OTP/TOTP):**
    - Static credentials (`FLATTRADE_USER_ID`, `FLATTRADE_PASSWORD_SHA256`, `FLATTRADE_API_KEY`, `FLATTRADE_API_SECRET`, `FLATTRADE_REDIRECT_URL`) are stored strictly in `/etc/flattrade-engine/env` (`chmod 600`) on EC2—NEVER hardcoded in TypeScript source files or committed to Git.
    - The backend exposes `POST /api/auth/daily-login` accepting `{ otp: string }` (6-digit SMS OTP or TOTP) from the authenticated Android client and executes all three Flattrade auth calls (`/auth/session` -> `/ftauth` -> `/trade/apitoken`) directly from the EC2 Static IPv4.
  - **Mandatory Fallback:** Keep `GET /api/auth/login-url` and `GET /auth/flattrade/callback` intact as a fallback browser OAuth path in case Flattrade ever triggers CAPTCHA or changes `/ftauth`.
  - **Strict Secret Redaction:** NEVER log `FLATTRADE_PASSWORD_SHA256`, `FLATTRADE_API_SECRET`, incoming `otp`, `request_code`, or the resulting `jKey` session token in Fastify logs, SQLite `order_audit_log`, or error responses.

## 3. Financial Math & Concurrency Invariants
- **Integer Paise Only:** Represent all prices internally as integer paise (`110.05` = `11005`). Never use floating-point arithmetic for price/tick/P&L calculations. Format to decimal strings (`"110.05"`) only at API/WS boundaries.
- **NSE Option Tick Size:** All order prices and triggers must be exact multiples of 5 paise (`0.05`).
- **Zero-DB Hot Path:** Never read or write SQLite inside the raw WebSocket tick handler. Active ladders live in an in-memory `Map<token, LadderPosition>`; persist to SQLite asynchronously only on discrete state transitions.
- **Per-Position Lock:** Acquire a non-blocking `isUpdating` lock per position before calling `PlaceOrder` or `ModifyOrder` so rapid ticks never fire duplicate broker requests.
- **Idempotency:** Deduplicate all mutating API requests by `commandId` (UUIDv4) with a 60-second in-memory TTL.