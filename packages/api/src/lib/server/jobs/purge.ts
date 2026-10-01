/**
 * The daily retention purge (§5.9 last paragraph, §5.2, §5.7, §11.6): hard-deletes soft-deleted
 * config rows once `settings.soft_delete_retention_days` has passed, stale `oauth_clients` and
 * expired `tokens` (§5.2), `audit_log` beyond `settings.audit_retention_days` (§5.7) and
 * `backup_runs` beyond `settings.recording_retention_days` (§11.6).
 */
import { sql, type Transaction } from 'kysely';

import { cutoffIso, type DB, type Db } from '@zamfono/shared';

import { deleteAudioFile } from '../audio/store.js';
import { loadSettings } from '../ops/settings/_shared.js';
import { deleteVoicemailFile } from '../ops/voicemails/_shared.js';
import {
  purgeOrphanForwardTargets,
  purgeOwnRuleRows
} from './purgeForwardTargets.js';
import { purgeDidBlocks, purgeTrunks } from './purgeGuarded.js';
import { purgeExpiredTokens, purgeOauthClients } from './purgeOauthTokens.js';

/** Every table with both an `id` and a `deleted_at` column, the shape the purge sweeps by age. */
type SoftDeleteTable = {
  [K in keyof DB]: DB[K] extends { id: string; deletedAt: string | null }
    ? K
    : never;
}[keyof DB];

/** The ids of `table`'s rows soft-deleted more than the caller's retention window ago. */
async function dueIds(
  trx: Transaction<DB>,
  table: SoftDeleteTable,
  cutoff: string
): Promise<string[]> {
  const rows = await trx
    .selectFrom(table)
    .select('id')
    .where('deletedAt', 'is not', null)
    .where('deletedAt', '<', cutoff)
    .execute();
  return rows.map(row => row.id);
}

/** Hard-deletes `table`'s rows soft-deleted more than `cutoff` ago. */
async function purgeSoftDeleted(
  trx: Transaction<DB>,
  table: SoftDeleteTable,
  cutoff: string
): Promise<void> {
  await trx
    .deleteFrom(table)
    .where('deletedAt', 'is not', null)
    .where('deletedAt', '<', cutoff)
    .execute();
}

/**
 * Deletes the due audio asset rows (§11.6 "Retention") and returns their filenames. The caller
 * unlinks the files once the transaction has committed, since a rollback restores the rows and
 * not the files.
 */
async function purgeAudioAssets(
  trx: Transaction<DB>,
  cutoff: string
): Promise<string[]> {
  const due = await trx
    .selectFrom('audioAssets')
    .select(['id', 'filename'])
    .where('deletedAt', 'is not', null)
    .where('deletedAt', '<', cutoff)
    .execute();
  if (due.length > 0) {
    await trx
      .deleteFrom('audioAssets')
      .where(
        'id',
        'in',
        due.map(asset => asset.id)
      )
      .execute();
  }
  return due.map(asset => asset.filename);
}

/**
 * The filenames of the voicemails in the due users' and ring groups' mailboxes (§11.6
 * "Retention"): purging the owner cascades the `voicemails` rows away through the FK, so the
 * caller unlinks their files once the transaction has committed, as for audio assets.
 */
async function dueVoicemailFilenames(
  trx: Transaction<DB>,
  dueUserIds: string[],
  dueRingGroupIds: string[]
): Promise<string[]> {
  const rows = await trx
    .selectFrom('voicemails')
    .select('filename')
    .where(eb =>
      eb.or([
        ...(dueUserIds.length > 0
          ? [eb('mailboxUserId', 'in', dueUserIds)]
          : []),
        ...(dueRingGroupIds.length > 0
          ? [eb('mailboxRingGroupId', 'in', dueRingGroupIds)]
          : [])
      ])
    )
    .execute();
  return rows.map(row => row.filename);
}

/** §5.7: `NULL` `audit_retention_days` keeps every entry; otherwise purges beyond the window. */
async function purgeAuditLog(
  trx: Transaction<DB>,
  auditRetentionDays: number | null,
  now: string
): Promise<void> {
  if (auditRetentionDays === null) {
    return;
  }
  await trx
    .deleteFrom('auditLog')
    .where('createdAt', '<', cutoffIso(now, auditRetentionDays))
    .execute();
}

/** §11.6 "Retention": `backup_runs` rows beyond `recording_retention_days`. */
async function purgeBackupRuns(
  trx: Transaction<DB>,
  cutoff: string
): Promise<void> {
  await trx.deleteFrom('backupRuns').where('startedAt', '<', cutoff).execute();
}

/**
 * Runs the full daily purge in one transaction (§5.9 last paragraph): an about-to-be-purged
 * entity's own forward-rule rows and stale schedules first, then orphaned `forward_targets`,
 * then the config entities and their files, then the remaining entities in FK order, a second
 * orphan sweep for targets the entity purge just freed, the trunks no route or target references
 * any more, and finally the security and history retention windows.
 *
 * A due DID, block or menu is only hard-deleted later in this same pass (`dueIds` only computes
 * users/ring groups/menus up front; dids/blocks purge further down), so at the first orphan sweep
 * it still physically holds its `target_id` and the target still looks referenced — e.g. a
 * soft-deleted DID pointing at a soft-deleted user's mailbox, or at a soft-deleted announcement
 * asset. `defer_foreign_keys` moves every `RESTRICT` check in this transaction to commit, so the
 * entity purges below may run before the row that references them is gone, as long as both are
 * gone by the time the transaction commits (SQLite's documented pattern for cyclic FK deletes,
 * already used in `users/update.ts`'s extension rename). The two orphan sweeps then differ only
 * in what the entity purges between them have freed.
 */
export async function runPurge(db: Db, now: string): Promise<void> {
  const settings = await loadSettings(db);
  const softDeleteCutoff = cutoffIso(now, settings.softDeleteRetentionDays);
  const purgedFiles = await db.transaction().execute(async trx => {
    await sql`PRAGMA defer_foreign_keys = ON`.execute(trx);
    const [dueUserIds, dueRingGroupIds, dueMenuIds] = await Promise.all([
      dueIds(trx, 'users', softDeleteCutoff),
      dueIds(trx, 'ringGroups', softDeleteCutoff),
      dueIds(trx, 'menus', softDeleteCutoff)
    ]);
    const voicemailFilenames = await dueVoicemailFilenames(
      trx,
      dueUserIds,
      dueRingGroupIds
    );
    await purgeOwnRuleRows(trx, dueUserIds, dueRingGroupIds, dueMenuIds);
    await purgeSoftDeleted(trx, 'oooRules', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'openingHours', softDeleteCutoff);

    await purgeOrphanForwardTargets(trx);

    await purgeSoftDeleted(trx, 'menus', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'ringGroups', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'users', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'devices', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'userGroups', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'contacts', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'webhooks', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'blockedNumbers', softDeleteCutoff);
    const audioFilenames = await purgeAudioAssets(trx, softDeleteCutoff);

    await purgeSoftDeleted(trx, 'outboundRoutes', softDeleteCutoff);
    await purgeSoftDeleted(trx, 'dids', softDeleteCutoff);
    await purgeDidBlocks(trx, softDeleteCutoff);
    await purgeSoftDeleted(trx, 'backupTargets', softDeleteCutoff);

    await purgeOrphanForwardTargets(trx);
    // After the sweep, so a `sip` target the purges above just orphaned no longer holds it.
    await purgeTrunks(trx, softDeleteCutoff);

    await purgeExpiredTokens(trx, now);
    await purgeOauthClients(trx, now);
    await purgeAuditLog(trx, settings.auditRetentionDays, now);
    await purgeBackupRuns(trx, cutoffIso(now, settings.recordingRetentionDays));
    return { audioFilenames, voicemailFilenames };
  });
  for (const filename of purgedFiles.audioFilenames) {
    // eslint-disable-next-line no-await-in-loop -- files are removed in turn once their rows are safely committed
    await deleteAudioFile(filename);
  }
  for (const filename of purgedFiles.voicemailFilenames) {
    // eslint-disable-next-line no-await-in-loop -- files are removed in turn once their rows are safely committed
    await deleteVoicemailFile(filename);
  }
}
