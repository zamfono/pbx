import type { Logger } from 'pino';

import { newId, nowIso, type Db } from '@zamfono/shared';

import rawEmergencyNumbers from './data/emergencyNumbers.json' with { type: 'json' };
import { encrypt, type Keyring } from './secretbox.js';
import { createDefaultBackupTarget } from './seedBackupTarget.js';
import {
  assertMailFromPresence,
  assertPasswordHash,
  countryFrom,
  extLengthFrom,
  mainDidFrom,
  requiredEnv,
  smtpPortFrom,
  smtpSecurityFrom,
  type SeedEnv
} from './seedEnv.js';
import { createOwnerExtension, createParkingSlots } from './seedExtensions.js';
import { createMohAssets } from './seedMoh.js';

// A country without an entry in the per-country table (§6.3 "First boot").
const FALLBACK_EMERGENCY_NUMBERS = ['112'];

const EMERGENCY_NUMBERS_TABLE: Record<string, string[]> = rawEmergencyNumbers;

/** The owner row created at first boot (§6.3 "First boot"), returning its id. */
async function createOwner(db: Db, env: SeedEnv, now: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: requiredEnv(env, 'BOOTSTRAP_OWNER_NAME'),
      email: requiredEnv(env, 'BOOTSTRAP_OWNER_EMAIL'),
      role: 'owner',
      passwordHash: requiredEnv(env, 'BOOTSTRAP_OWNER_PASSWORD_HASH'),
      createdAt: now
    })
    .execute();
  return id;
}

/** The main-number DID (§11.4 `main_did_id`), targeting the owner until an admin retargets it. */
async function createMainDid(
  db: Db,
  ownerId: string,
  env: SeedEnv,
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
  return FALLBACK_EMERGENCY_NUMBERS;
}

async function createSettings(
  db: Db,
  params: {
    env: SeedEnv;
    kr: Keyring;
    mainDidId: string;
    extLength: number;
    log: Logger;
  }
): Promise<void> {
  const { env, kr, mainDidId, extLength, log } = params;
  const country = countryFrom(env);
  const smtpHost = env.SMTP_HOST ?? null;
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
      smtpUser: env.SMTP_USER ?? null,
      smtpPasswordEnc:
        env.SMTP_PASSWORD === undefined ? null : encrypt(kr, env.SMTP_PASSWORD),
      mailFrom: smtpHost === null ? null : requiredEnv(env, 'MAIL_FROM')
    })
    .execute();
}

// Seeds an empty database from `.env` (§6.3 "First boot") in one transaction, so a validation
// failure or a write error leaves it empty for a retry. Runs only while `users` holds no row.
export async function seedIfEmpty(
  db: Db,
  env: SeedEnv,
  kr: Keyring,
  mediaDir: string,
  log: Logger
): Promise<'seeded' | 'skipped'> {
  const existing = await db.selectFrom('users').select('id').executeTakeFirst();
  if (existing) {
    return 'skipped';
  }
  assertMailFromPresence(env);
  assertPasswordHash(env);
  const now = nowIso();
  const extLength = extLengthFrom(env);
  await db.transaction().execute(async trx => {
    const ownerId = await createOwner(trx, env, now);
    await createOwnerExtension(trx, ownerId, extLength);
    const mainDid = await createMainDid(trx, ownerId, env, now);
    await createSettings(trx, {
      env,
      kr,
      mainDidId: mainDid.id,
      extLength,
      log
    });
    await createParkingSlots(trx, extLength);
    await createMohAssets(trx, env, mediaDir, now, log);
    await createDefaultBackupTarget(trx, env, kr, now, log);
  });
  return 'seeded';
}
