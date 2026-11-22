# scalpX Backend Documentation

## Project Purpose & Architecture
**scalpX** is a single-user SENSEX & index options high-speed trading cockpit designed for disciplined execution with automated server-side ratcheting stop-loss (SL) engines. 

The backend architecture follows Hexagonal (Ports & Adapters) principles implemented as a strict Node.js TypeScript modular service:
- **Zero-DB Hot Path:** In-memory order & ratcheting ladder engine processing real-time market ticks without synchronous database bottlenecks.
- **SQLite WAL Mode (`scalpx.db`):** Persistent, crash-safe state store for active ladders, order audit log, daily session tokens (AES-256-GCM encrypted), closed trades, and authorized devices.
- **Fail-Closed Security Invariants:** Fail-closed trading controls (`TRADING_ENABLED=false` by default), strict device pre-authorization, TOTP replay mitigation, constant-time secret evaluation, and complete isolation of broker credentials from client devices.

---

## Device Provisioning & Authentication Architecture

### 1. Root Cause of "403 - Device is not pre-authorized"
The system requires an administrator to register an Android client's hardware/installation UUID before that device is permitted to authenticate. If an un-provisioned device attempts to exchange a TOTP code at `POST /api/auth/device/authenticate`, the backend rejects the request with HTTP 403 (`Device is not pre-authorized.`) to prevent unauthorized devices from attempting brute-force TOTP attacks.

### 2. Device Provisioning Flow (`POST /api/auth/provision-device`)
Android devices cannot self-enroll. An administrator must explicitly authorize the device UUID using the server's `DEVICE_ENROLLMENT_SECRET`:
- **Endpoint:** `POST /api/auth/provision-device`
- **Headers:** `X-Device-Id: <DEVICE_UUID>`
- **Request Body:**
  ```json
  {
    "enrollmentSecret": "<DEVICE_ENROLLMENT_SECRET>",
    "deviceName": "Owner Android Device"
  }
  ```
- **Response:**
  ```json
  {
    "status": "ok",
    "deviceId": "<DEVICE_UUID>",
    "deviceStatus": "AUTHORIZED"
  }
  ```
- **Security Decisions:**
  - Idempotent enrollment: repeated provisioning updates the friendly name and re-authorizes previously revoked devices.
  - Does NOT issue a JWT directly upon provisioning (the client must still prove physical possession via RFC 6238 TOTP).
  - Never logs or exposes enrollment secrets.

### 3. TOTP Authentication Flow (`POST /api/auth/device/authenticate`)
Once pre-authorized, the Android device submits its six-digit TOTP:
- **Endpoint:** `POST /api/auth/device/authenticate`
- **Headers:** `X-Device-Id: <DEVICE_UUID>`
- **Request Body:**
  ```json
  {
    "deviceId": "<DEVICE_UUID>",
    "totp": "123456",
    "deviceName": "Owner Android Device"
  }
  ```
- **Validation Steps:**
  1. Header `X-Device-Id` and body `deviceId` are validated.
  2. Device authorization status is verified against SQLite (`authorized_devices`).
  3. Rejection with HTTP 401 if revoked, or HTTP 403 if unregistered.
  4. TOTP verified using server-side `DEVICE_TOTP_SECRET` with ±1 step window (30-second step).
  5. SQLite atomic conditional update on `last_totp_step` ensures replay prevention.
  6. Rate limiting blocks repeated failed attempts (5 failures triggers 5-minute lockout).
  7. On success, an HS256 JWT (15-minute expiry) is issued with `{ sub: "scalpx-owner", role: "owner", deviceId: "<UUID>" }`.

### 4. Device Management API
- **Revoke Device:**
  - **Endpoint:** `POST /api/auth/revoke-device`
  - **Headers:** `Authorization: Bearer <JWT>`, `X-Device-Id: <DEVICE_UUID>`
  - Sets `revoked_at = Date.now()` in SQLite; immediate rejection on subsequent API calls.

---

## Required Environment Variables

Configured in `/etc/scalpx/env` (production) or local `.env`:
- `PORT`: Server port (default: `3000`).
- `HOST`: Server bind address (`127.0.0.1`).
- `BROKER_MODE`: Must be `live` (paper mode is unsupported).
- `TRADING_ENABLED`: `false` by default (blocks live order creation until explicitly toggled).
- `APP_JWT_SECRET`: High-entropy key for signing 15-minute device JWTs.
- `DEVICE_ENROLLMENT_SECRET`: Minimum 32-character secret for owner provisioning.
- `DEVICE_TOTP_SECRET`: Base32 secret for RFC 6238 TOTP authentication.
- `DB_SESSION_ENCRYPTION_KEY`: 64-hex-character (32-byte) key for AES-256-GCM encryption of broker sessions.
- `FLATTRADE_USER_ID`, `FLATTRADE_API_KEY`, `FLATTRADE_API_SECRET`, `FLATTRADE_REDIRECT_URL`: Official Flattrade Pi API credentials.

---

## Administrator Provisioning Guide

To authorize an Android device:
1. Obtain the stable `DEVICE_UUID` from the Android app (displayed in Settings or logcat).
2. Execute the provisioning command from a secure shell:
   ```bash
   curl -X POST https://trade.nagabyte.com/api/auth/provision-device \
     -H "Content-Type: application/json" \
     -H "X-Device-Id: <DEVICE_UUID>" \
     -d '{
       "enrollmentSecret": "<DEVICE_ENROLLMENT_SECRET>",
       "deviceName": "Owner Pixel 9"
     }'
   ```
3. Open the Android scalpX app, enter the current 6-digit TOTP from your authenticator app, and authenticate.
