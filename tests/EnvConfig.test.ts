import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/env.js';

const VALID_LIVE_ENV = {
  TRADING_ENABLED: 'false',
  FLATTRADE_USER_ID: 'FT123456',
  FLATTRADE_API_KEY: 'real_api_key',
  FLATTRADE_API_SECRET: 'real_api_secret',
  FLATTRADE_REDIRECT_URL: 'https://trade.nagabyte.com/api/auth/flattrade/callback',
  DB_SESSION_ENCRYPTION_KEY: 'b'.repeat(64),
};

describe('live-only environment configuration', () => {
  it('selects the sole supported LIVE environment and defaults trading to disabled', () => {
    const cfg = loadConfig({ ...VALID_LIVE_ENV } as NodeJS.ProcessEnv);
    expect(cfg.BROKER_MODE).toBe('live');
    expect(cfg.TRADING_ENABLED).toBe(false);
    expect(cfg.HOST).toBe('127.0.0.1');
  });

  it('accepts an explicit LAN listener for local physical-device testing', () => {
    const cfg = loadConfig({
      ...VALID_LIVE_ENV,
      HOST: '0.0.0.0',
      PORT: '3000',
    } as NodeJS.ProcessEnv);

    expect(cfg.HOST).toBe('0.0.0.0');
    expect(cfg.PORT).toBe(3000);
    expect(cfg.TRADING_ENABLED).toBe(false);
  });

  it('rejects legacy paper mode rather than silently using a simulator', () => {
    expect(() => loadConfig({ ...VALID_LIVE_ENV, BROKER_MODE: 'paper' } as NodeJS.ProcessEnv)).toThrow(/PAPER broker mode is not supported/);
  });

  it('requires encrypted session storage and valid Flattrade credentials', () => {
    const missingEncryption = { ...VALID_LIVE_ENV };
    delete (missingEncryption as Partial<typeof missingEncryption>).DB_SESSION_ENCRYPTION_KEY;
    expect(() => loadConfig(missingEncryption as NodeJS.ProcessEnv)).toThrow(/DB_SESSION_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...VALID_LIVE_ENV, FLATTRADE_USER_ID: 'MOCK_USER' } as NodeJS.ProcessEnv)).toThrow(/FLATTRADE_USER_ID/);
    expect(() => loadConfig({ ...VALID_LIVE_ENV, FLATTRADE_API_KEY: 'MOCK_KEY' } as NodeJS.ProcessEnv)).toThrow(/FLATTRADE_API_KEY/);
  });

  it('allows trading only through the explicit server-side flag', () => {
    expect(loadConfig({ ...VALID_LIVE_ENV } as NodeJS.ProcessEnv).TRADING_ENABLED).toBe(false);
    expect(loadConfig({ ...VALID_LIVE_ENV, TRADING_ENABLED: 'true' } as NodeJS.ProcessEnv).TRADING_ENABLED).toBe(true);
  });

  it('does not accept or return broker password credentials', () => {
    const cfg = loadConfig({ ...VALID_LIVE_ENV, FLATTRADE_PASSWORD: 'unused' } as NodeJS.ProcessEnv);
    expect((cfg as Record<string, unknown>).FLATTRADE_PASSWORD).toBeUndefined();
    expect((cfg as Record<string, unknown>).FLATTRADE_PASSWORD_SHA256).toBeUndefined();
  });
});
