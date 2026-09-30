import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { issueResetToken } from './auth/tokens.js';
import rawEmergencyNumbers from './data/emergencyNumbers.json' with { type: 'json' };
import { sendMail } from './mail/index.js';
import { encrypt, type Keyring } from './secretbox.js';
import {
  assertHashOrRelay,
  assertMailFromPresence,
  assertOriginWhenMailingSetupLink,
  countryFrom,
  extLengthFrom,
  mainDidFrom,
  requiredEnv,
  smtpPortFrom,
  smtpSecurityFrom
} from './seedEnv.js';
import { createOwnerExtension, createParkingSlots } from './seedExtensions.js';
import { createMohAssets } from './seedMoh.js';

const RANDOM_PASSWORD_BYTES = 32;
const EU_DEFAULT_KEY = 'EU_DEFAULT';
const FALLBACK_EMERGENCY_NUMBERS = ['112'];
// The mount point of `src/routes/auth/set-password/+page.svelte` (§5.2 "Authentication pages").
const SET_PASSWORD_PATH = '/auth/set-password';

type EmergencyNumbersTable = Record<string, string[]>;

// A JSON import attribute, not a Vite-only glob, so the module loads the same under any bundler
// or none (`package.json`'s `build` bundles `server.ts` through esbuild, with no Vite transform).
const EMERGENCY_NUMBERS_TABLE: EmergencyNumbersTable = rawEmergencyNumbers;

/** Owner row created at first boot (§6.3 "First boot"). */
type SeededOwner = { id: string; hasPasswordHash: boolean };

// A password nobody knows: satisfies `users`' `password_hash IS NOT NULL` check until the
// setup mail's link sets a real one (§6.3 "First boot"). The prefix is not a valid Argon2id PHC
// string (which starts `$argon2`), so `verifyPassword` (`auth/password.ts`) rejects it as "no
// password set" before ever calling `argon2.verify` on it.
export const UNSET_PASSWORD_HASH_PREFIX = 'unset:';
function unusablePasswordPlaceholder(): string {
  return `${UNSET_PASSWORD_HASH_PREFIX}${randomBytes(RANDOM_PASSWORD_BYTES).toString('hex')}`;
}

async function createOwner(
  db: Db,
  env: NodeJS.ProcessEnv,
  now: string
): Promise<SeededOwner> {
  const hasPasswordHash = Boolean(env.BOOTSTRAP_OWNER_PASSWORD_HASH);
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: requiredEnv(env, 'BOOTSTRAP_OWNER_NAME'),
      email: requiredEnv(env, 'BOOTSTRAP_OWNER_EMAIL'),
      role: 'owner',
      passwordHash: hasPasswordHash
        ? requiredEnv(env, 'BOOTSTRAP_OWNER_PASSWORD_HASH')
        : unusablePasswordPlaceholder(),
      createdAt: now
    })
    .execute();
  return { id, hasPasswordHash };
}

/** The main-number DID (§11.4 `main_did_id`), targeting the owner until an admin retargets it. */
async function createMainDid(
  db: Db,
  ownerId: string,
  env: NodeJS.ProcessEnv,
  now: string
): Promise<{ id: string }> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, userId: ownerId })
    .execute();
  const id = newId();
  await db
    .insertInto('dids')
    .values({
      id,
      number: mainDidFrom(env),
      label: null,
      targetId,
      createdAt: now,
      deletedAt: null
    })
    .execute();
  return { id };
}

/** The per-country table (§6.3 "First boot"); an unlisted country falls back to `["112"]`. */
function emergencyNumbersFor(country: string, log: Logger): string[] {
  const numbers = Object.hasOwn(EMERGENCY_NUMBERS_TABLE, country)
    ? EMERGENCY_NUMBERS_TABLE[country]
    : undefined;
  if (numbers !== undefined) {
    return numbers;
  }
  log.warn(
    `seed: no emergency numbers for country ${country}, using ${FALLBACK_EMERGENCY_NUMBERS.join(',')}`
  );
  return EMERGENCY_NUMBERS_TABLE[EU_DEFAULT_KEY] ?? FALLBACK_EMERGENCY_NUMBERS;
}

async function createSettings(
  db: Db,
  params: {
    env: NodeJS.ProcessEnv;
    kr: Keyring;
    mainDidId: string;
    extLength: number;
    log: Logger;
  }
): Promise<void> {
  const { env, kr, mainDidId, extLength, log } = params;
  const country = countryFrom(env);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Compose's `${SMTP_HOST:-}` yields '' when unset, so a falsy check is required, not just null/undefined
  const smtpHost = env.SMTP_HOST || null;
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: requiredEnv(env, 'COMPANY_NAME'),
      mainDidId,
      country,
      extLength,
      emergencyNumbersJson: JSON.stringify(emergencyNumbersFor(country, log)),
      smtpHost,
      smtpPort: smtpPortFrom(env),
      smtpSecurity: smtpSecurityFrom(env),
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Compose's `${SMTP_USER:-}` yields '' when unset, so a falsy check is required, not just null/undefined
      smtpUser: env.SMTP_USER || null,
      smtpPasswordEnc: env.SMTP_PASSWORD
        ? encrypt(kr, env.SMTP_PASSWORD)
        : null,
      mailFrom: smtpHost ? requiredEnv(env, 'MAIL_FROM') : null
    })
    .execute();
}

/**
 * Without a seeded hash, the owner gets the set-password mail instead (§6.3 "First boot"); an
 * undelivered link is the owner's only way in, so a non-`'sent'` outcome throws (run inside
 * `seedIfEmpty`'s transaction, this rolls the whole boot back for a retry on the next start
 * rather than leaving a placeholder hash nobody can turn into a real login).
 */
async function sendSetupMail(
  db: Db,
  kr: Keyring,
  params: { env: NodeJS.ProcessEnv; ownerId: string; now: string }
): Promise<void> {
  const { env, ownerId, now } = params;
  const { raw, expiresAt } = await issueResetToken(db, ownerId, 'setup', now);
  // `assertOriginWhenMailingSetupLink` has already required `ORIGIN` before the transaction.
  const link = `${requiredEnv(env, 'ORIGIN')}${SET_PASSWORD_PATH}?token=${raw}`;
  const outcome = await sendMail(db, kr, {
    kind: 'setup',
    to: { userId: ownerId },
    values: { link, linkExpiresAt: expiresAt }
  });
  if (outcome !== 'sent') {
    throw new Error(`seed: setup mail was not sent (${outcome})`);
  }
}

// Seeds an empty database from `.env` (§6.3 "First boot") in one transaction, so a validation
// failure or a write error leaves it empty for a retry. Runs only while `users` holds no row.
export async function seedIfEmpty(
  db: Db,
  env: NodeJS.ProcessEnv,
  kr: Keyring,
  mediaDir: string,
  log: Logger
): Promise<'seeded' | 'skipped'> {
  const existing = await db.selectFrom('users').select('id').executeTakeFirst();
  if (existing) {
    return 'skipped';
  }
  assertMailFromPresence(env);
  assertHashOrRelay(env);
  assertOriginWhenMailingSetupLink(env);
  const now = nowIso();
  const extLength = extLengthFrom(env);
  await db.transaction().execute(async trx => {
    const created = await createOwner(trx, env, now);
    await createOwnerExtension(trx, created.id, extLength);
    const mainDid = await createMainDid(trx, created.id, env, now);
    await createSettings(trx, {
      env,
      kr,
      mainDidId: mainDid.id,
      extLength,
      log
    });
    await createParkingSlots(trx, extLength);
    await createMohAssets(trx, env, mediaDir, now, log);
    if (!created.hasPasswordHash) {
      await sendSetupMail(trx, kr, { env, ownerId: created.id, now });
    }
  });
  return 'seeded';
}
