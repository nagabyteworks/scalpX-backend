/**
 * TokenEncryption: AES-256-GCM authenticated encryption for Flattrade session tokens.
 *
 * Layout on disk (hex): <12-byte IV>.<16-byte auth tag>.<ciphertext>
 * Keys are loaded from DB_SESSION_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 * Never logs plaintext tokens.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEPARATOR = '.';

export class TokenEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenEncryptionError';
  }
}

export class TokenEncryption {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
      throw new TokenEncryptionError('DB_SESSION_ENCRYPTION_KEY must be a 64-character lowercase hex string (32 bytes)');
    }
    this.key = Buffer.from(keyHex, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}${SEPARATOR}${tag.toString('hex')}${SEPARATOR}${encrypted.toString('hex')}`;
  }

  /**
   * Returns null if the ciphertext is corrupted or was encrypted with a different key.
   * Never throws on bad ciphertext — caller must handle null safely.
   */
  decrypt(ciphertext: string): string | null {
    try {
      const parts = ciphertext.split(SEPARATOR);
      if (parts.length !== 3) return null;
      const [ivHex, tagHex, dataHex] = parts as [string, string, string];
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const data = Buffer.from(dataHex, 'hex');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      // Corrupted ciphertext or wrong key — return null, do NOT log details
      return null;
    }
  }

  /**
   * Returns true when a stored value looks like an encrypted token (has 3 parts separated by '.')
   * and false when it's a legacy plaintext token.
   */
  static isEncrypted(stored: string): boolean {
    return stored.split(SEPARATOR).length === 3;
  }
}
