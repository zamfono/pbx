import type { Logger } from 'pino';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { sealTargetSecret } from './ops/backups/_secret.js';
import { DEFAULT_FORGET_POLICY } from './ops/backups/_shared.js';
import type { Keyring } from './secretbox.js';

/**
 * The restic repository of the default `local` target, on the `backups` volume `compose.yaml`
 * mounts at `/backups` (§6.5 "Default target").
 */
export const LOCAL_BACKUP_REPOSITORY = '/backups/restic';

/**
 * Creates the default `local` backup target (§6.5 "Default target") when `BACKUP_PASSWORD` is set
 * and the stack has never had a target: none live, none deleted. So a fresh stack, and one
 * upgraded from a release without the default, back up from their first night on, while a target
 * an admin deleted stays deleted. The password comes from `.env`, not from the database the
 * repository backs up, so a restore that has `.env` can open the repository.
 */
export async function seedBackupTarget(
  db: Db,
  env: { BACKUP_PASSWORD?: string | undefined },
  kr: Keyring,
  log: Logger
): Promise<'seeded' | 'skipped'> {
  const password = env.BACKUP_PASSWORD;
  if (password === undefined) {
    return 'skipped';
  }
  const existing = await db
    .selectFrom('backupTargets')
    .select('id')
    .executeTakeFirst();
  if (existing) {
    return 'skipped';
  }
  const id = newId();
  await db
    .insertInto('backupTargets')
    .values({
      id,
      kind: 'local',
      paramsJson: JSON.stringify({
        path: LOCAL_BACKUP_REPOSITORY,
        forget: DEFAULT_FORGET_POLICY
      }),
      enabled: 1,
      secretEnc: sealTargetSecret(kr, { resticPassword: password }),
      createdAt: nowIso()
    })
    .execute();
  log.info(
    { targetId: id, path: LOCAL_BACKUP_REPOSITORY },
    'boot: default local backup target created'
  );
  return 'seeded';
}
