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

## 3. Financial Math & Concurrency Invariants
- **Integer Paise Only:** Represent all prices internally as integer paise (`110.05` = `11005`). Never use floating-point arithmetic for price/tick/P&L calculations. Format to decimal strings (`"110.05"`) only at API/WS boundaries.
- **NSE Option Tick Size:** All order prices and triggers must be exact multiples of 5 paise (`0.05`).
- **Zero-DB Hot Path:** Never read or write SQLite inside the raw WebSocket tick handler. Active ladders live in an in-memory `Map<token, LadderPosition>`; persist to SQLite asynchronously only on discrete state transitions.
- **Per-Position Lock:** Acquire a non-blocking `isUpdating` lock per position before calling `PlaceOrder` or `ModifyOrder` so rapid ticks never fire duplicate broker requests.
- **Idempotency:** Deduplicate all mutating API requests by `commandId` (UUIDv4) with a 60-second in-memory TTL.