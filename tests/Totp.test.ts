import { describe, expect, it } from 'vitest';
import { matchingTotpStep } from '../src/application/Totp.js';

describe('device TOTP validation', () => {
  it('matches the RFC 6238 SHA-1 test vector within the allowed time window', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(matchingTotpStep(secret, '287082', 59_000)).toBe(1);
    expect(matchingTotpStep(secret, '287082', 59_000 + 31_000)).toBeNull();
  });

  it('rejects malformed secrets and non-six-digit input', () => {
    expect(matchingTotpStep('not-a-base32-secret', '123456', 1_000_000)).toBeNull();
    expect(matchingTotpStep('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '12345', 1_000_000)).toBeNull();
  });
});
