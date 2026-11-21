# scalpX API Contract & Client Integration Guide

## 1. Overview & Security Architecture
scalpX is a server-authoritative one-click options execution and ratcheting stop-loss backend.
- **Base URL:** `https://your-domain.com` (or `http://127.0.0.1:3000` in dev)
- **WebSocket URL:** `wss://your-domain.com/ws` (or `ws://127.0.0.1:3000/ws` in dev)
- **Authentication:** All `/api/*` and `/ws` endpoints require:
  1. Header `Authorization: Bearer <JWT>` signed with HS256 using `APP_JWT_SECRET`.
  2. Header `X-Device-Id: <UUID>` identifying the client device.
- **Precision:** All monetary amounts in requests/responses are integer **paise** (`110.05` = `11005` paise).

---

## 2. Public / Unauthenticated Endpoints

### 2.1 Health Check
- **Method & Path:** `GET /health`
- **Response `200 OK`:**
```json
{
  "status": "ok",
  "brokerMode": "live",
  "brokerConnected": true,
  "wsFeedHealthy": true,
  "openPositionsCount": 1,
  "memoryRssMb": 68,
  "uptimeSec": 1420
}
```

### 2.2 Flattrade OAuth Callback
- **Method & Path:** `GET /auth/flattrade/callback?code=<REQUEST_CODE>`
- **Description:** Receives the OAuth authentication code from Flattrade browser login, completes SHA256 token exchange, boots live feeds, reconciles positions, and redirects to Android app deep link.
- **Response:** `302 Found` with `Location: scalper://auth/success`

---

## 3. Authenticated REST Endpoints (`/api/*`)

### 3.1 Get OAuth Login URL (Fallback)
- **Method & Path:** `GET /api/auth/login-url`
- **Headers:** `Authorization: Bearer <JWT>`, `X-Device-Id: <UUID>`
- **Response `200 OK`:**
```json
{
  "loginUrl": "https://auth.flattrade.in/?app_key=YOUR_API_KEY"
}
```

### 3.2 Single-User Daily OTP Login (Primary)
- **Method & Path:** `POST /api/auth/daily-login`
- **Auth:** Required (`Authorization: Bearer <JWT>`, `X-Device-Id: <UUID>`)
- **Description:** Submits the morning 6-digit SMS OTP or TOTP. The server executes the 3-step Flattrade auth chain (`/auth/session` -> `/ftauth` -> `/trade/apitoken`) from its static IPv4 and establishes the daily broker session.
- **Request Body:**
```json
{
  "otp": "123456"
}
```
- **Response `200 OK`:**
```json
{
  "status": "ok",
  "message": "Daily Flattrade authentication successful",
  "brokerConnected": true
}
```
- **Error Responses:**
  - `400 Bad Request`: `{ "error": "OTP must be a 6-digit numeric string" }`
  - `401 Unauthorized`: `{ "error": "Flattrade authentication failed: Invalid OTP or session expired" }`

### 3.2 Get Option Chain
- **Method & Path:** `GET /api/option-chain?symbol=NIFTY&strikes=10`
- **Response `200 OK`:** Returns available option chain strikes and Greeks.

### 3.3 One-Click Order Execution
- **Method & Path:** `POST /api/orders/one-click`
- **Headers:** `Authorization: Bearer <JWT>`, `X-Device-Id: <UUID>`
- **Request Body:**
```json
{
  "commandId": "550e8400-e29b-41d4-a716-446655440000",
  "token": "26000",
  "tradingSymbol": "NIFTY26NOV24500CE",
  "exchange": "NFO",
  "side": "BUY",
  "lots": 2,
  "lotSize": 25,
  "product": "I",
  "initialSlPoints": 10.0,
  "ladderConfig": {
    "firstMilestonePaise": 11000,
    "stepSizePaise": 500,
    "breakoutBufferPaise": 100,
    "slippageBufferPaise": 150
  }
}
```
- **Response `200 OK`:**
```json
{
  "token": "26000",
  "symbol": "NIFTY26NOV24500CE",
  "side": "BUY",
  "quantity": 50,
  "entryPricePaise": 10005,
  "nextMilestonePaise": 11000,
  "stepSizePaise": 500,
  "breakoutBufferPaise": 100,
  "slippageBufferPaise": 150,
  "activeSlOrderId": "FT_SL_991",
  "activeSlTriggerPaise": 9005,
  "status": "OPEN",
  "isPaused": false
}
```
- **Error Codes:**
  - `400`: Validation failed (invalid UUID, missing fields, non-positive quantities).
  - `422`: Risk limit breached (max lots, max open qty, or daily kill switch).

### 3.4 Live Edit Ladder Parameters
- **Method & Path:** `PATCH /api/ladders/:token`
- **Request Body (all optional):**
```json
{
  "nextMilestonePaise": 11500,
  "stepSizePaise": 600,
  "breakoutBufferPaise": 100,
  "slippageBufferPaise": 150,
  "paused": false
}
```
- **Response `200 OK`:** Updated `LadderPosition` object.
- **Error Codes:** `404` if token position not found.

### 3.5 Exit Position
- **Method & Path:** `POST /api/orders/exit-position`
- **Request Body:**
```json
{
  "commandId": "7a353664-d62f-4886-bda2-bfd54c86bf41",
  "token": "26000"
}
```
- **Response `200 OK`:**
```json
{
  "success": true,
  "token": "26000",
  "commandId": "7a353664-d62f-4886-bda2-bfd54c86bf41",
  "orderId": "FT_ORD_EXIT_26000",
  "status": "FILLED"
}
```

### 3.6 Panic Exit All Positions
- **Method & Path:** `POST /api/orders/exit-all`
- **Request Body:**
```json
{
  "commandId": "8b843322-1234-4567-8901-abcdef012345"
}
```
- **Response `200 OK`:**
```json
{
  "success": true,
  "message": "Panic exit executed for all open positions"
}
```

### 3.7 Today's Trade & PnL Summary
- **Method & Path:** `GET /api/trades/today`
- **Response `200 OK`:**
```json
{
  "activePositions": [...],
  "openPositionsCount": 1,
  "timestamp": 1732174200000
}
```

---

## 4. Client WebSocket API (`/ws`)

### 4.1 Connection & Upgrade Authentication
Connect to `wss://your-domain.com/ws?token=<JWT>&deviceId=<UUID>` or pass `Authorization: Bearer <JWT>` and `X-Device-Id: <UUID>` headers during HTTP handshake.

### 4.2 Throttled Trading Snapshot (Every 150 ms)
The server coalesces high-frequency market ticks and broadcasts a compact snapshot every 150 ms:
```json
{
  "type": "SNAPSHOT",
  "timestamp": 1732174200150,
  "openPositionsCount": 1,
  "positions": [
    {
      "token": "26000",
      "symbol": "NIFTY26NOV24500CE",
      "quantity": 50,
      "entryPricePaise": 10000,
      "currentLtpPaise": 11150,
      "unrealizedPnlPaise": 57500,
      "nextMilestonePaise": 11500,
      "activeSlTriggerPaise": 11000,
      "activeSlLimitPaise": 10850,
      "isPaused": false,
      "status": "OPEN"
    }
  ]
}
```

### 4.3 High-Priority Events (Immediate Push)
These bypass the 150 ms throttle and emit instantly upon occurrence:
- `ORDER_FILLED`: `{ "type": "ORDER_FILLED", "data": { "token": "26000", "entryPricePaise": 10000, "quantity": 50 } }`
- `SL_RATCHETED`: `{ "type": "SL_RATCHETED", "data": { "token": "26000", "newTriggerPaise": 11500, "newLimitPaise": 11350 } }`
- `ORDER_REJECTED`: `{ "type": "ORDER_REJECTED", "data": { "token": "26000", "reason": "Margin insufficient" } }`
- `FEED_STALE`: `{ "type": "FEED_STALE", "data": { "message": "No ticks received for 3000ms" } }`
- `MANUAL_INTERVENTION_REQUIRED`: `{ "type": "MANUAL_INTERVENTION_REQUIRED", "data": { "token": "26000", "error": "Broker timeout" } }`
