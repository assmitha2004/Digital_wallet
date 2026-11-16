import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, currentStep, generateSecret, hotp, otpauthUri, verifyTotp } from '../src/totp.js';

// RFC 6238 appendix B test secret: the ASCII bytes "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors (last 6 of the 8-digit codes)', () => {
    // time (s) -> 8-digit SHA1 code from the RFC; authenticator apps show the last 6 digits.
    for (const [seconds, code] of [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ]) {
      expect(hotp(RFC_SECRET, Math.floor(seconds / 30))).toBe(code.slice(-6));
    }
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts the current code and one step of clock drift either way, nothing further', () => {
    const secret = generateSecret();
    const now = Date.now();
    const step = currentStep(now);
    expect(verifyTotp(secret, hotp(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step + 2), now)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step - 2), now)).toBeNull();
  });

  it('rejects malformed codes', () => {
    const secret = generateSecret();
    for (const code of ['', '12345', '1234567', 'abcdef', null, undefined, 123456]) {
      expect(verifyTotp(secret, code)).toBeNull();
    }
  });

  it('builds an otpauth URI an authenticator app can scan', () => {
    expect(otpauthUri({ secret: 'ABC', accountName: 'a@b.dev' })).toBe(
      'otpauth://totp/PayLedger%3Aa%40b.dev?secret=ABC&issuer=PayLedger&algorithm=SHA1&digits=6&period=30',
    );
  });
});
