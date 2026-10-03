/**
 * The first-boot seed's `.env` values (§6.3 "First boot"), read and validated: a missing or
 * malformed value throws, which stops `api` before it serves a request.
 */
import { z } from 'zod';

import { isE164 } from '@zamfono/shared';

import { isKnownCountry } from './ops/settings/country.js';

// The extension length's floor (§11.4 `ext_length >= 2`) is what leaves room for the nine parking
// slots `seedExtensions.ts` numbers.
const EXT_LENGTH_FLOOR = 2;
const DEFAULT_EXT_LENGTH = 3;
const DEFAULT_SMTP_PORT = 465;
const MIN_SMTP_PORT = 1;
const MAX_SMTP_PORT = 65535;
const DEFAULT_SMTP_SECURITY = 'tls';

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`seed: ${name} is required`);
  }
  return value;
}

/**
 * `MAIL_FROM` is required and validated whenever `SMTP_HOST` is set (§6.3 "First boot": "a
 * missing or malformed value stops `api` with an error before it serves a request").
 */
export function assertMailFromPresence(env: NodeJS.ProcessEnv): void {
  if (!env.SMTP_HOST) {
    return;
  }
  if (!z.email().safeParse(env.MAIL_FROM).success) {
    throw new Error(
      'seed: MAIL_FROM is required and must be a valid address when SMTP_HOST is set'
    );
  }
}

/** Either the seeded hash or a mail relay must be present (§6.3 "First boot"). */
export function assertHashOrRelay(env: NodeJS.ProcessEnv): void {
  if (!env.BOOTSTRAP_OWNER_PASSWORD_HASH && !env.SMTP_HOST) {
    throw new Error(
      'seed: BOOTSTRAP_OWNER_PASSWORD_HASH or SMTP_HOST is required'
    );
  }
}

/** `EXT_LENGTH`, parsed and floored at 2 (§11.4 `ext_length >= 2`, which the parking slots need). */
export function extLengthFrom(env: NodeJS.ProcessEnv): number {
  if (env.EXT_LENGTH === undefined) {
    return DEFAULT_EXT_LENGTH;
  }
  const parsed = Number(env.EXT_LENGTH);
  if (!Number.isInteger(parsed) || parsed < EXT_LENGTH_FLOOR) {
    throw new Error(
      `seed: EXT_LENGTH must be an integer >= ${EXT_LENGTH_FLOOR}`
    );
  }
  return parsed;
}

/** `COUNTRY`, required and one `settings.update` would accept (§11.4): a code without a calling
 *  code would make every later number normalization of §9.4 throw. */
export function countryFrom(env: NodeJS.ProcessEnv): string {
  const value = requiredEnv(env, 'COUNTRY');
  if (!isKnownCountry(value)) {
    throw new Error(
      `seed: COUNTRY must be an ISO 3166-1 alpha-2 code, got ${value}`
    );
  }
  return value;
}

/** `MAIN_DID`, required and E.164 (§9.4 "Inbound number normalization" matches on that format). */
export function mainDidFrom(env: NodeJS.ProcessEnv): string {
  const value = requiredEnv(env, 'MAIN_DID');
  if (!isE164(value)) {
    throw new Error('seed: MAIN_DID must be E.164');
  }
  return value;
}

/** `SMTP_SECURITY`, `tls` when unset, else one of the column's `CHECK` values (§10.2 "Transport"). */
export function smtpSecurityFrom(env: NodeJS.ProcessEnv): 'tls' | 'starttls' {
  const value = env.SMTP_SECURITY;
  if (!value) {
    return DEFAULT_SMTP_SECURITY;
  }
  if (value !== 'tls' && value !== 'starttls') {
    throw new Error(
      `seed: SMTP_SECURITY must be tls or starttls, got ${value}`
    );
  }
  return value;
}

/** `SMTP_PORT`, parsed and range-checked against the column's `CHECK (BETWEEN 1 AND 65535)`. */
export function smtpPortFrom(env: NodeJS.ProcessEnv): number {
  if (!env.SMTP_PORT) {
    return DEFAULT_SMTP_PORT;
  }
  const parsed = Number(env.SMTP_PORT);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_SMTP_PORT ||
    parsed > MAX_SMTP_PORT
  ) {
    throw new Error(
      `seed: SMTP_PORT must be an integer between ${MIN_SMTP_PORT} and ${MAX_SMTP_PORT}`
    );
  }
  return parsed;
}
