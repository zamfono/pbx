/**
 * The first-boot seed's `.env` values (§6.3 "First boot"), read and validated: a missing or
 * malformed value throws, which stops `api` before it serves a request.
 */
import type * as privateEnv from '$app/env/private';
import { z } from 'zod';

import { isE164 } from '@zamfono/shared';

import { settingsInputSchema } from './ops/settings/_input.js';
import { isKnownCountry } from './ops/settings/country.js';
import { MAX_PORT } from './ops/trunks/_shared.js';

// The extension length's floor (§11.4 `ext_length >= 2`) is what leaves room for the nine parking
// slots `seedExtensions.ts` numbers.
const EXT_LENGTH_FLOOR = 2;
const DEFAULT_EXT_LENGTH = 3;
const DEFAULT_SMTP_PORT = 465;
const DEFAULT_SMTP_SECURITY = 'tls';

type PrivateEnv = typeof privateEnv;

type SeedVariable =
  | 'BOOTSTRAP_OWNER_EMAIL'
  | 'BOOTSTRAP_OWNER_NAME'
  | 'BOOTSTRAP_OWNER_PASSWORD_HASH'
  | 'COMPANY_NAME'
  | 'COUNTRY'
  | 'EXT_LENGTH'
  | 'MAIL_FROM'
  | 'MAIN_DID'
  | 'SMTP_HOST'
  | 'SMTP_PASSWORD'
  | 'SMTP_PORT'
  | 'SMTP_SECURITY'
  | 'SMTP_USER';

/** The seed's variables as `src/env.ts` reads them: `undefined` while unset or empty. */
export type SeedEnv = Partial<Pick<PrivateEnv, SeedVariable>> &
  Pick<PrivateEnv, 'MOH_SOURCE_DIR'>;

export function requiredEnv(env: SeedEnv, name: SeedVariable): string {
  const value = env[name];
  if (value === undefined) {
    throw new Error(`seed: ${name} is required`);
  }
  return value;
}

/**
 * `MAIL_FROM` is required and validated whenever `SMTP_HOST` is set (§6.3 "First boot": "a
 * missing or malformed value stops `api` with an error before it serves a request").
 */
export function assertMailFromPresence(env: SeedEnv): void {
  if (env.SMTP_HOST === undefined) {
    return;
  }
  if (!z.email().safeParse(env.MAIL_FROM).success) {
    throw new Error(
      'seed: MAIL_FROM is required and must be a valid address when SMTP_HOST is set'
    );
  }
}

/** Either the seeded hash or a mail relay must be present (§6.3 "First boot"). */
export function assertHashOrRelay(env: SeedEnv): void {
  if (
    env.BOOTSTRAP_OWNER_PASSWORD_HASH === undefined &&
    env.SMTP_HOST === undefined
  ) {
    throw new Error(
      'seed: BOOTSTRAP_OWNER_PASSWORD_HASH or SMTP_HOST is required'
    );
  }
}

/** `EXT_LENGTH`, parsed and floored at 2 (§11.4 `ext_length >= 2`, which the parking slots need). */
export function extLengthFrom(env: SeedEnv): number {
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
export function countryFrom(env: SeedEnv): string {
  const value = requiredEnv(env, 'COUNTRY');
  if (!isKnownCountry(value)) {
    throw new Error(
      `seed: COUNTRY must be an ISO 3166-1 alpha-2 code, got ${value}`
    );
  }
  return value;
}

/** `MAIN_DID`, required and E.164 (§9.4 "Inbound number normalization" matches on that format). */
export function mainDidFrom(env: SeedEnv): string {
  const value = requiredEnv(env, 'MAIN_DID');
  if (!isE164(value)) {
    throw new Error('seed: MAIN_DID must be E.164');
  }
  return value;
}

/** `SMTP_SECURITY`, `tls` when unset, else a value `settings.update` accepts (§10.2 "Transport"). */
export function smtpSecurityFrom(env: SeedEnv): 'tls' | 'starttls' {
  const value = env.SMTP_SECURITY;
  if (value === undefined) {
    return DEFAULT_SMTP_SECURITY;
  }
  const parsed = settingsInputSchema.shape.smtpSecurity
    .unwrap()
    .safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `seed: SMTP_SECURITY must be tls or starttls, got ${value}`
    );
  }
  return parsed.data;
}

/** `SMTP_PORT`, parsed and range-checked as `settings.update` checks it. */
export function smtpPortFrom(env: SeedEnv): number {
  if (env.SMTP_PORT === undefined) {
    return DEFAULT_SMTP_PORT;
  }
  const parsed = settingsInputSchema.shape.smtpPort
    .unwrap()
    .safeParse(Number(env.SMTP_PORT));
  if (!parsed.success) {
    throw new Error(
      `seed: SMTP_PORT must be an integer between 1 and ${MAX_PORT}`
    );
  }
  return parsed.data;
}
