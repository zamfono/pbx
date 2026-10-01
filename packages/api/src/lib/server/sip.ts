import { randomBytes } from 'node:crypto';

// §9.3 "Naming": SIP passwords are 24 random application-generated characters; a device's slug is
// a short random identifier generated once per device, unique only within its own user's devices.
const SIP_PASSWORD_LENGTH = 24;
const SLUG_LENGTH = 5;
const ALPHANUMERIC =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BYTE_RANGE = 256;

/**
 * `length` characters drawn uniformly from `alphabet` via rejection sampling: a plain
 * `byte % alphabet.length` would bias the low characters whenever `alphabet.length` does not
 * evenly divide 256, which neither alphabet below does.
 */
function randomFrom(alphabet: string, length: number): string {
  const limit = BYTE_RANGE - (BYTE_RANGE % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length - out.length)) {
      if (byte < limit) {
        const char = alphabet[byte % alphabet.length];
        // `byte % alphabet.length` is always a valid index into `alphabet`.
        if (char === undefined) {
          throw new Error('randomFrom: alphabet index out of range');
        }
        out += char;
        if (out.length === length) {
          break;
        }
      }
    }
  }
  return out;
}

/** A new SIP password: 24 random `[A-Za-z0-9]` characters (§5.2 "SIP credentials"). */
export function newSipPassword(): string {
  return randomFrom(ALPHANUMERIC, SIP_PASSWORD_LENGTH);
}

/** A new device slug: 5 random lowercase-alphanumeric characters (§9.3 "Naming"). */
export function newSlug(): string {
  return randomFrom(SLUG_ALPHABET, SLUG_LENGTH);
}

/** A device's PJSIP endpoint name, `e<ext>-d<slug>` (§9.3 "Naming"). */
export function sipUsername(ext: string, slug: string): string {
  return `e${ext}-d${slug}`;
}
