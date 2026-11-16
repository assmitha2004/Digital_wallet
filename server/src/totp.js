// Time-based one-time passwords (RFC 6238), the 6-digit codes shown by Google Authenticator,
// Microsoft Authenticator, Authy etc. Written with node:crypto only, so every step is visible.
import crypto from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new random 160-bit secret, base32-encoded (what authenticator apps expect). */
export const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** HOTP (RFC 4226): HMAC-SHA1 of the counter, then "dynamic truncation" to 6 digits. */
export function hotp(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Checks a code against the current 30-second step and one step either side (clock drift).
 * Returns the matching step number (used to stop the same code being accepted twice), or null.
 */
export function verifyTotp(secret, code, now = Date.now(), window = 1) {
  if (!secret || typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (let offset = -window; offset <= window; offset++) {
    const expected = Buffer.from(hotp(secret, step + offset));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return step + offset;
  }
  return null;
}

/** The URI an authenticator app reads from a QR code. */
export function otpauthUri({ secret, accountName, issuer = 'PayLedger' }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
