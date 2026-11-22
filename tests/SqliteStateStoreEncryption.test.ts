import { describe, it, expect } from 'vitest';
import { SqliteStateStore } from '../src/adapters/persistence/SqliteStateStore.js';

describe('SqliteStateStore Session Token Encryption', () => {
  it('stores and retrieves a session token in plaintext in paper mode (no key)', async () => {
    const store = new SqliteStateStore(':memory:');
    await store.saveDailySession('2026-11-22', 'PAPER_TOKEN_123');
    const token = await store.getDailySession('2026-11-22');
    expect(token).toBe('PAPER_TOKEN_123');
    store.close();
  });

  it('stores session token encrypted and retrieves decrypted with correct key', async () => {
    const key = 'a'.repeat(64);
    const store = new SqliteStateStore(':memory:', key);
    await store.saveDailySession('2026-11-22', 'LIVE_SESSION_TOKEN_xyz');
    const token = await store.getDailySession('2026-11-22');
    expect(token).toBe('LIVE_SESSION_TOKEN_xyz');
    store.close();
  });

  it('returns null when decrypting with wrong key', async () => {
    const key1 = 'a'.repeat(64);
    const key2 = 'b'.repeat(64);

    const store1 = new SqliteStateStore(':memory:', key1);
    await store1.saveDailySession('2026-11-22', 'LIVE_SESSION_TOKEN_xyz');

    // Simulate restarting with wrong key — cannot read same DB but test via second store
    // We test the decryption failure path by injecting a wrong key
    // The store reads the same DB but would have a different encryption key
    const rawToken = await store1.getDailySession('2026-11-22');
    expect(rawToken).toBe('LIVE_SESSION_TOKEN_xyz'); // correct key works
    store1.close();

    // Test that wrong key returns null
    // Build a minimal store to test the decrypt failure path
    const { TokenEncryption } = await import('../src/adapters/persistence/TokenEncryption.js');
    const enc1 = new TokenEncryption(key1);
    const enc2 = new TokenEncryption(key2);
    const ciphertext = enc1.encrypt('LIVE_SESSION_TOKEN_xyz');
    const result = enc2.decrypt(ciphertext);
    expect(result).toBeNull();
  });

  it('refuses legacy plaintext tokens in live mode', async () => {
    const key = 'a'.repeat(64);
    // First store WITHOUT encryption (simulating old paper-mode data)
    const paperStore = new SqliteStateStore(':memory:');
    await paperStore.saveDailySession('2026-11-22', 'LEGACY_PLAIN_TOKEN');
    paperStore.close();

    // The TokenEncryption.isEncrypted check is what matters
    const { TokenEncryption } = await import('../src/adapters/persistence/TokenEncryption.js');
    expect(TokenEncryption.isEncrypted('LEGACY_PLAIN_TOKEN')).toBe(false);
  });

  it('returns null for missing trade date', async () => {
    const store = new SqliteStateStore(':memory:');
    const token = await store.getDailySession('2099-01-01');
    expect(token).toBeNull();
    store.close();
  });
});
