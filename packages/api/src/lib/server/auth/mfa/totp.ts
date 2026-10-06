/**
 * TOTP (RFC 6238) as authenticator apps implement it: HMAC-SHA-1, 6 digits, 30-second steps, and
 * the secret exchanged in base32 (RFC 4648) inside an `otpauth://` URI (§5.2 "Two-factor
 * authentication").
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { epochSeconds } from '@zamfono/shared';

const STEP_S = 30;
const DIGITS = 6;
// One step either side of the current one, for a clock that drifts or a code typed late.
const ALLOWED_DRIFT_STEPS = 1;
// 160 bits, the length RFC 4226 §4 recommends and every authenticator app takes.
const SECRET_BYTES = 20;
const COUNTER_BYTES = 8;
const DECIMAL = 10;
// RFC 4226 §5.4 dynamic truncation: the low nibble of the last byte is the offset of a 31-bit
// big-endian integer, taken here as remainders rather than masks.
const OFFSET_MODULUS = 16;
const SIGN_MODULUS = 0x80_00_00_00;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_BITS = 5;
const BYTE_BITS = 8;
const BINARY = 2;
const BASE32_GROUP = 4;

/** `bytes` in unpadded RFC 4648 base32: the bits in groups of five, the last padded with zeros. */
export function base32Encode(bytes: Buffer): string {
  const bits = [...bytes]
    .map(byte => byte.toString(BINARY).padStart(BYTE_BITS, '0'))
    .join('');
  const groups = bits.match(new RegExp(`.{1,${BASE32_BITS}}`, 'gu')) ?? [];
  return groups
    .map(group =>
      BASE32_ALPHABET.charAt(
        Number.parseInt(group.padEnd(BASE32_BITS, '0'), BINARY)
      )
    )
    .join('');
}

/** `secret` (base32) as the space-separated groups of four an authenticator app's manual entry
 *  reads most easily. */
export function groupedSecret(secret: string): string {
  return (
    secret.match(new RegExp(`.{1,${BASE32_GROUP}}`, 'gu'))?.join(' ') ?? ''
  );
}

/** A fresh 160-bit TOTP secret. */
export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** The HOTP value (RFC 4226) of `secret` at `counter`, `digits` long. */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const message = Buffer.alloc(COUNTER_BYTES);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac.at(-1) ?? 0) % OFFSET_MODULUS;
  const binary = mac.readUInt32BE(offset) % SIGN_MODULUS;
  return String(binary % DECIMAL ** digits).padStart(digits, '0');
}

/** The time step `timeMs` falls in. */
export function totpStep(timeMs: number): number {
  return Math.floor(epochSeconds(timeMs) / STEP_S);
}

/** The TOTP code of `secret` at `timeMs`, `digits` long (6 by default; the RFC 6238 test
 *  vectors are 8 digits). */
export function totpAt(
  secret: Buffer,
  timeMs: number,
  digits = DIGITS
): string {
  return hotp(secret, totpStep(timeMs), digits);
}

/**
 * The step `code` is valid for at `timeMs`, within one step either side, or `null`. A step at
 * or before `lastStep`, the step of the code last accepted, is never accepted again, so a code
 * seen once cannot be replayed.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  timeMs: number,
  lastStep: number
): number | null {
  if (!new RegExp(`^\\d{${DIGITS}}$`, 'u').test(code)) {
    return null;
  }
  const now = totpStep(timeMs);
  for (
    let step = now - ALLOWED_DRIFT_STEPS;
    step <= now + ALLOWED_DRIFT_STEPS;
    step += 1
  ) {
    const expected = Buffer.from(hotp(secret, step, DIGITS));
    if (step > lastStep && timingSafeEqual(expected, Buffer.from(code))) {
      return step;
    }
  }
  return null;
}

/** The `otpauth://` URI an authenticator app scans (Key Uri Format): the label names the issuer
 *  and the account, and `issuer` repeats it, as current apps expect. */
export function otpauthUri(
  issuer: string,
  account: string,
  secret: Buffer
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
