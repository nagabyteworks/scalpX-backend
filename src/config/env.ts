import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

export const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  BROKER_MODE: z.enum(['paper', 'live']).default('paper'),
  APP_JWT_SECRET: z.string().min(8, 'APP_JWT_SECRET must be at least 8 characters'),

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

  // Persistence & Risk
  DB_PATH: z.string().default('./scalpx.db'),
  MAX_LOTS_PER_ORDER: z.coerce.number().default(4),
  DEFAULT_LOT_SIZE: z.coerce.number().default(25),
  MAX_OPEN_QTY_PER_SYMBOL: z.coerce.number().default(200),
  MAX_DAILY_LOSS_PAISE: z.coerce.number().default(500000), // 5,000 INR
});

export type RawAppEnv = z.infer<typeof EnvSchema>;

export interface AppConfig extends Omit<RawAppEnv, 'FLATTRADE_PASSWORD'> {
  FLATTRADE_PASSWORD_SHA256: string;
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
