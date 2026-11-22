import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

export const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  BROKER_MODE: z.enum(['paper', 'live']).default('paper'),
  /**
   * TRADING_ENABLED independently controls whether new real orders can be submitted.
   * Default: false (fail-closed). Must be set to 'true' explicitly to allow trading.
   * Even in LIVE mode, trading is blocked unless TRADING_ENABLED=true.
   * Emergency exits and protective SL handling are always permitted regardless of this flag.
   */
  TRADING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  APP_JWT_SECRET: z.string().min(8, 'APP_JWT_SECRET must be at least 8 characters'),
  /**
   * High-entropy enrollment secret used by the owner to provision new Android devices.
   * Stored securely in /etc/scalpx/env on EC2; never included in the Android APK.
   */
  DEVICE_ENROLLMENT_SECRET: z.string().min(16).default('scalpx_dev_enrollment_secret_min16_chars'),

  // Flattrade API v2 Credentials
  FLATTRADE_USER_ID: z.string().default('MOCK_USER'),
  FLATTRADE_PASSWORD: z.string().optional(),
  FLATTRADE_PASSWORD_SHA256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, 'FLATTRADE_PASSWORD_SHA256 must be a 64-char hex string')
    .optional(),
  FLATTRADE_API_KEY: z.string().default('MOCK_KEY'),
  FLATTRADE_API_SECRET: z.string().default('MOCK_SECRET'),
  FLATTRADE_REDIRECT_URL: z.string().default('http://127.0.0.1:3000/auth/flattrade/callback'),
  FLATTRADE_ACCOUNT_ID: z.string().optional(),
  FLATTRADE_WS_URL: z.string().optional(),
  FLATTRADE_AUTH_BASE_URL: z.string().optional(), // For testing or custom auth host

  /**
   * DB_SESSION_ENCRYPTION_KEY: 32-byte hex key (64 hex chars) for AES-256-GCM encryption
   * of broker session tokens stored in SQLite. Required in LIVE mode.
   * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   */
  DB_SESSION_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, 'DB_SESSION_ENCRYPTION_KEY must be a 64-char hex string')
    .optional(),

  // Persistence
  DB_PATH: z.string().default('./scalpx.db'),
});

export type RawAppEnv = z.infer<typeof EnvSchema>;

export interface AppConfig extends Omit<RawAppEnv, 'FLATTRADE_PASSWORD'> {
  FLATTRADE_PASSWORD_SHA256: string;
  TRADING_ENABLED: boolean;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(rawEnv);
  if (!parsed.success) {
    console.error('❌ FATAL: Environment variable validation failed:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    throw new Error('Environment variable validation failed');
  }

  const data = parsed.data;

  // Derive password hash if plaintext password provided
  let passwordSha256 = data.FLATTRADE_PASSWORD_SHA256?.toLowerCase();
  if (!passwordSha256 && data.FLATTRADE_PASSWORD && data.FLATTRADE_PASSWORD.trim().length > 0) {
    passwordSha256 = crypto.createHash('sha256').update(data.FLATTRADE_PASSWORD.trim()).digest('hex').toLowerCase();
  }

  // Fail fast for live mode requirements
  if (data.BROKER_MODE === 'live') {
    const missing: string[] = [];
    if (!data.FLATTRADE_USER_ID || data.FLATTRADE_USER_ID === 'MOCK_USER') {
      missing.push('FLATTRADE_USER_ID');
    }
    if (!passwordSha256) {
      missing.push('FLATTRADE_PASSWORD_SHA256 (or FLATTRADE_PASSWORD)');
    }
    if (!data.FLATTRADE_API_KEY || data.FLATTRADE_API_KEY === 'MOCK_KEY') {
      missing.push('FLATTRADE_API_KEY');
    }
    if (!data.FLATTRADE_API_SECRET || data.FLATTRADE_API_SECRET === 'MOCK_SECRET') {
      missing.push('FLATTRADE_API_SECRET');
    }
    if (!data.FLATTRADE_REDIRECT_URL) {
      missing.push('FLATTRADE_REDIRECT_URL');
    }

    if (missing.length > 0) {
      throw new Error(`Missing required Flattrade live credentials: ${missing.join(', ')}`);
    }

    // Require encryption key for live mode (session tokens must not be stored plaintext)
    if (!data.DB_SESSION_ENCRYPTION_KEY) {
      throw new Error(
        'Missing required DB_SESSION_ENCRYPTION_KEY for LIVE mode. ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      );
    }

    // Warn if TRADING_ENABLED is not set (safe default remains false)
    if (!data.TRADING_ENABLED) {
      console.warn(
        '⚠️  LIVE mode started with TRADING_ENABLED=false. ' +
        'New order placement is BLOCKED. Set TRADING_ENABLED=true only after explicit approval.'
      );
    }
  }

  // Fallback hash for paper testing
  if (!passwordSha256) {
    passwordSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
  }

  // Discard plaintext password
  const { FLATTRADE_PASSWORD: _, ...cleanConfig } = data;

  return {
    ...cleanConfig,
    FLATTRADE_PASSWORD_SHA256: passwordSha256,
  };
}
