/**
 * The one queue every backup run of this process waits its turn in (§6.5 "Backups"): the
 * scheduled runs, the manual ones and the automatic update's (§6.3 "Updates"), so no two share a
 * restic repository at once; the default backup hour and the default maintenance moment are both
 * 03:00.
 */
import type { Db } from '@zamfono/shared';

import type { BackupRunRow } from '../ops/backups/_shared.js';
import type { Keyring } from '../secretbox.js';
import {
  createBackupRun,
  performBackup,
  type BackupJobDeps
} from './backup.js';

// The tail of the work queued so far: each waits for the one before it, whatever its outcome.
const turns: { tail: Promise<unknown> } = { tail: Promise.resolve() };

/** Runs `work` once every backup queued before it has ended. */
export async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const result = turns.tail.then(work, work);
  turns.tail = result.catch(() => undefined);
  return result;
}

/** The ids of the live, enabled backup targets. */
export async function enabledTargetIds(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('backupTargets')
    .select('id')
    .where('enabled', '=', 1)
    .where('deletedAt', 'is', null)
    .execute();
  return rows.map(row => row.id);
}

/**
 * Backs up every enabled target, in its turn, and returns the runs, for the automatic update
 * (§6.3 "Updates"); empty when no target is enabled.
 */
export async function backupEnabledTargets(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps
): Promise<BackupRunRow[]> {
  return inTurn(async () => {
    const runs: BackupRunRow[] = [];
    for (const targetId of await enabledTargetIds(db)) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; runs must serialize
      const { run, target } = await createBackupRun(db, targetId, deps);
      // eslint-disable-next-line no-await-in-loop -- see above
      runs.push(await performBackup(db, kr, run, target, deps));
    }
    return runs;
  });
}
