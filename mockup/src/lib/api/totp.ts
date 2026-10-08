/**
 * The demo's authenticator codes: each person's secret, the six digits the simulated app shows for
 * it, and the check the second step and a new app's setup make. The digits come from a hash of the secret
 * and the 30-second step, not RFC 6238, so the simulated app and the check agree with each other
 * and with no real authenticator.
 */
export const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 160 bits as base32 (§5.2): 32 characters. */
export const SECRET_LENGTH = 32;
const TOTP_STEP_MS = 30_000;
const TOTP_DIGITS = 6;
/** Steps either side of the current one a code is still accepted for (clock drift, typing time). */
const DRIFT_STEPS = 1;

/** FNV-1a, enough to derive stable demo values from a string. */
function hash(text: string, seed = 0x811c9dc5): number {
  let value = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** A pseudo-random sequence seeded by `text` (mulberry32). */
export function sequence(text: string): () => number {
  let state = hash(text);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The secret of `userId`'s authenticator app, as the demo's simulated app and the check use it. */
export const existingSecret = (userId: string): string => {
  const next = sequence(`totp:${userId}`);
  return Array.from(
    { length: SECRET_LENGTH },
    () => BASE32[Math.floor(next() * BASE32.length)]
  ).join('');
};

const codeAt = (secret: string, step: number): string =>
  String(hash(`${secret}:${step}`) % 10 ** TOTP_DIGITS).padStart(
    TOTP_DIGITS,
    '0'
  );

/** The six digits the demo authenticator shows for `secret` at `now`, and the seconds left. */
export function demoTotp(
  secret: string,
  now: number
): { code: string; secondsLeft: number } {
  return {
    code: codeAt(secret, Math.floor(now / TOTP_STEP_MS)),
    secondsLeft: Math.ceil((TOTP_STEP_MS - (now % TOTP_STEP_MS)) / 1000)
  };
}

/** Whether `code` (spaces allowed) is what the app shows for `secret` around `now`. */
export function totpMatches(
  secret: string,
  code: string,
  now: number
): boolean {
  const typed = code.replaceAll(/\s/gu, '');
  const step = Math.floor(now / TOTP_STEP_MS);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset += 1) {
    if (codeAt(secret, step + offset) === typed) {
      return true;
    }
  }
  return false;
}
