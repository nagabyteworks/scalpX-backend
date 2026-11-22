import { createHmac, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer | null {
  const normalized = secret.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  if (normalized.length < 16 || !/^[A-Z2-7]+$/.test(normalized)) return null;
  let bits = '';
  for (const char of normalized) bits += ALPHABET.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codeAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

/** Verify a six digit RFC 6238 TOTP with a ±1 time-step clock window. */
export function matchingTotpStep(secretText: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = decodeBase32(secretText);
  if (!key) return null;
  const current = Math.floor(nowMs / 30_000);
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(codeAt(key, step));
    if (timingSafeEqual(expected, Buffer.from(code)) && step >= 0) return step;
  }
  return null;
}
