import { describe, expect, it } from 'vitest';

import {
  base32Encode,
  groupedSecret,
  matchTotp,
  otpauthUri,
  totpAt,
  totpStep
} from './totp.js';

const MS = 1000;
const STEP_MS = 30_000;
// RFC 6238 Appendix B: the SHA-1 seed and its 8-digit test vectors.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1_111_111_109, '07081804'],
  [1_111_111_111, '14050471'],
  [1_234_567_890, '89005924'],
  [2_000_000_000, '69279037'],
  [20_000_000_000, '65353130']
];
const RFC_DIGITS = 8;

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)(
    'matches the SHA-1 test vector at T=%i',
    (timeS, code) => {
      expect(totpAt(RFC_SECRET, timeS * MS, RFC_DIGITS)).toBe(code);
    }
  );

  it('issues six digits, the last six of the 8-digit value', () => {
    expect(totpAt(RFC_SECRET, 59 * MS)).toBe('287082');
  });

  it('accepts the current step and one either side, nothing further', () => {
    const now = 1_234_567_890 * MS;
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      const code = totpAt(RFC_SECRET, now + offset * STEP_MS);
      expect(matchTotp(RFC_SECRET, code, now, 0)).toBe(step + offset);
    }
    for (const offset of [-2, 2]) {
      const code = totpAt(RFC_SECRET, now + offset * STEP_MS);
      expect(matchTotp(RFC_SECRET, code, now, 0)).toBeNull();
    }
  });

  it('refuses a step at or before the last one accepted, so a code is never replayed', () => {
    const now = 1_234_567_890 * MS;
    const code = totpAt(RFC_SECRET, now);
    expect(matchTotp(RFC_SECRET, code, now, totpStep(now))).toBeNull();
    expect(matchTotp(RFC_SECRET, code, now, totpStep(now) - 1)).toBe(
      totpStep(now)
    );
  });

  it('refuses anything but six digits', () => {
    expect(matchTotp(RFC_SECRET, '12345', 0, -1)).toBeNull();
    expect(matchTotp(RFC_SECRET, '1234567', 0, -1)).toBeNull();
    expect(matchTotp(RFC_SECRET, 'abcdef', 0, -1)).toBeNull();
  });
});

describe('the secret as an authenticator app reads it', () => {
  it('is RFC 4648 base32, grouped by four for manual entry', () => {
    // RFC 4648 §10: BASE32("foobar") = "MZXW6YTBOI======", unpadded here.
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(groupedSecret('MZXW6YTBOI')).toBe('MZXW 6YTB OI');
  });

  it('travels in an otpauth URI naming issuer and account', () => {
    expect(
      otpauthUri('Acme GmbH', 'anna@example.com', Buffer.from('foobar'))
    ).toBe(
      'otpauth://totp/Acme%20GmbH:anna%40example.com?secret=MZXW6YTBOI&issuer=Acme+GmbH'
    );
  });
});
