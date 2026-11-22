import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/env.js';

const VALID_LIVE_ENV = {
  BROKER_MODE: 'live',
  TRADING_ENABLED: 'false',
  APP_JWT_SECRET: 'test_secret_12345678',
  FLATTRADE_USER_ID: 'FT123456',
  FLATTRADE_PASSWORD_SHA256: 'a'.repeat(64),
  FLATTRADE_API_KEY: 'real_api_key',
  FLATTRADE_API_SECRET: 'real_api_secret',
  FLATTRADE_REDIRECT_URL: 'https://trade.nagabyte.com/api/auth/flattrade/callback',
  DB_SESSION_ENCRYPTION_KEY: 'b'.repeat(64),
};

describe('env.ts Config Validation', () => {
  describe('PAPER mode (default)', () => {
    it('loads with minimal config in paper mode', () => {
      const cfg = loadConfig({ APP_JWT_SECRET: 'test_secret_12345678' } as NodeJS.ProcessEnv);
      expect(cfg.BROKER_MODE).toBe('paper');
      expect(cfg.TRADING_ENABLED).toBe(false);
      expect(cfg.HOST).toBe('127.0.0.1');
      expect(cfg.FLATTRADE_REDIRECT_URL).toBe('https://trade.nagabyte.com/api/auth/flattrade/callback');
    });

    it('defaults TRADING_ENABLED to false', () => {
      const cfg = loadConfig({ APP_JWT_SECRET: 'test_secret_12345678' } as NodeJS.ProcessEnv);
      expect(cfg.TRADING_ENABLED).toBe(false);
    });
  });

  describe('LIVE mode requirements', () => {
    it('accepts valid live config with encryption key', () => {
      const cfg = loadConfig(VALID_LIVE_ENV as NodeJS.ProcessEnv);
      expect(cfg.BROKER_MODE).toBe('live');
      expect(cfg.TRADING_ENABLED).toBe(false);
      expect(cfg.DB_SESSION_ENCRYPTION_KEY).toBe('b'.repeat(64));
    });

    it('throws when DB_SESSION_ENCRYPTION_KEY is missing in live mode', () => {
      const env = { ...VALID_LIVE_ENV };
      delete (env as Partial<typeof env>).DB_SESSION_ENCRYPTION_KEY;
      expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/DB_SESSION_ENCRYPTION_KEY/);
    });

    it('throws when FLATTRADE_USER_ID is MOCK_USER in live mode', () => {
      expect(() =>
        loadConfig({ ...VALID_LIVE_ENV, FLATTRADE_USER_ID: 'MOCK_USER' } as NodeJS.ProcessEnv)
      ).toThrow(/FLATTRADE_USER_ID/);
    });

    it('throws when FLATTRADE_API_KEY is MOCK_KEY in live mode', () => {
      expect(() =>
        loadConfig({ ...VALID_LIVE_ENV, FLATTRADE_API_KEY: 'MOCK_KEY' } as NodeJS.ProcessEnv)
      ).toThrow(/FLATTRADE_API_KEY/);
    });

    it('throws when password hash is missing in live mode', () => {
      const env = { ...VALID_LIVE_ENV };
      delete (env as Partial<typeof env>).FLATTRADE_PASSWORD_SHA256;
      expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/FLATTRADE_PASSWORD/);
    });

    it('accepts TRADING_ENABLED=true in live mode', () => {
      const cfg = loadConfig({ ...VALID_LIVE_ENV, TRADING_ENABLED: 'true' } as NodeJS.ProcessEnv);
      expect(cfg.TRADING_ENABLED).toBe(true);
    });
  });

  describe('TRADING_ENABLED control', () => {
    it('TRADING_ENABLED defaults to false in paper mode', () => {
      const cfg = loadConfig({ APP_JWT_SECRET: 'test_secret_12345678' } as NodeJS.ProcessEnv);
      expect(cfg.TRADING_ENABLED).toBe(false);
    });

    it('TRADING_ENABLED can be explicitly false', () => {
      const cfg = loadConfig({ APP_JWT_SECRET: 'test_secret_12345678', TRADING_ENABLED: 'false' } as NodeJS.ProcessEnv);
      expect(cfg.TRADING_ENABLED).toBe(false);
    });

    it('TRADING_ENABLED can be explicitly true in paper mode', () => {
      const cfg = loadConfig({ APP_JWT_SECRET: 'test_secret_12345678', TRADING_ENABLED: 'true' } as NodeJS.ProcessEnv);
      expect(cfg.TRADING_ENABLED).toBe(true);
    });
  });

  describe('Password handling security', () => {
    it('derives SHA256 from plaintext password and discards plaintext', () => {
      const cfg = loadConfig({
        APP_JWT_SECRET: 'test_secret_12345678',
        FLATTRADE_PASSWORD: 'mypassword123',
      } as NodeJS.ProcessEnv);
      expect(cfg.FLATTRADE_PASSWORD_SHA256).toMatch(/^[a-f0-9]{64}$/);
      // Plaintext must not be in the returned config
      expect((cfg as Record<string, unknown>)['FLATTRADE_PASSWORD']).toBeUndefined();
    });
  });
});
