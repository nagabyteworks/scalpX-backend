import { describe, it, expect } from 'vitest';
import { TokenEncryption, TokenEncryptionError } from '../../src/adapters/persistence/TokenEncryption.js';

const VALID_KEY = 'a'.repeat(64); // 64 hex chars (32 bytes)

describe('TokenEncryption', () => {
  describe('constructor validation', () => {
    it('accepts a valid 64-char hex key', () => {
      expect(() => new TokenEncryption(VALID_KEY)).not.toThrow();
    });

    it('rejects a key that is too short', () => {
      expect(() => new TokenEncryption('abc123')).toThrow(TokenEncryptionError);
    });

    it('rejects a key with non-hex characters', () => {
      expect(() => new TokenEncryption('z'.repeat(64))).toThrow(TokenEncryptionError);
    });
  });

  describe('encrypt / decrypt roundtrip', () => {
    it('encrypts and decrypts a Flattrade-like session token', () => {
      const enc = new TokenEncryption(VALID_KEY);
      const token = 'abc1234567890abcdef1234567890abcdef12';
      const ciphertext = enc.encrypt(token);
      expect(ciphertext).not.toBe(token);
      expect(ciphertext.split('.').length).toBe(3);
      const decrypted = enc.decrypt(ciphertext);
      expect(decrypted).toBe(token);
    });

    it('produces different ciphertexts for the same plaintext (random IV)', () => {
      const enc = new TokenEncryption(VALID_KEY);
      const token = 'same_token_value';
      const c1 = enc.encrypt(token);
      const c2 = enc.encrypt(token);
      expect(c1).not.toBe(c2);
      expect(enc.decrypt(c1)).toBe(token);
      expect(enc.decrypt(c2)).toBe(token);
    });
  });

  describe('decrypt error handling', () => {
    it('returns null for a corrupted ciphertext without throwing', () => {
      const enc = new TokenEncryption(VALID_KEY);
      expect(enc.decrypt('not.a.valid.ciphertext.at.all')).toBeNull();
    });

    it('returns null when decrypted with wrong key', () => {
      const enc1 = new TokenEncryption(VALID_KEY);
      const enc2 = new TokenEncryption('b'.repeat(64));
      const ciphertext = enc1.encrypt('secret_token');
      expect(enc2.decrypt(ciphertext)).toBeNull();
    });

    it('returns null for empty string', () => {
      const enc = new TokenEncryption(VALID_KEY);
      expect(enc.decrypt('')).toBeNull();
    });
  });

  describe('isEncrypted', () => {
    it('returns true for encrypted format', () => {
      const enc = new TokenEncryption(VALID_KEY);
      const ciphertext = enc.encrypt('token');
      expect(TokenEncryption.isEncrypted(ciphertext)).toBe(true);
    });

    it('returns false for a plain session token', () => {
      expect(TokenEncryption.isEncrypted('PAPER_TOKEN_2026-11-22_1234567890')).toBe(false);
    });
  });
});
