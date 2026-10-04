import type { Logger } from 'pino';

import { newId, type Db } from '@zamfono/shared';

import { sealTargetSecret } from './ops/backups/_secret.js';
import { DEFAULT_FORGET_POLICY } from './ops/backups/_shared.js';
import type { Keyring } from './secretbox.js';
import type { SeedEnv } from './seedEnv.js';

/**
 * The restic repository of the default `local` target, on the `backups` volume `compose.yaml`
 * mounts at `/backups` (§6.5 "Default target").
 */
export const LOCAL_BACKUP_REPOSITORY = '/backups/restic';

/**
 * Creates the default `local` backup target (§6.5 "Default target") in the first-boot seed's
 * transaction when `BACKUP_PASSWORD` is set, so a stack backs up from its first night on and a
 * target an admin deletes later stays deleted. The password comes from `.env`, not from the
 * database the repository backs up, so a restore that has `.env` can open the repository.
 */
export async function createDefaultBackupTarget(
  db: Db,
  env: SeedEnv,
  kr: Keyring,
  now: string,
  log: Logger
): Promise<void> {
  const password = env.BACKUP_PASSWORD;
  if (password === undefined) {
    return;
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
      createdAt: now
    })
    .execute();
  log.info(
    { targetId: id, path: LOCAL_BACKUP_REPOSITORY },
    'seed: default local backup target created'
  );
}
