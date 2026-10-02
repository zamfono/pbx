import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { Db, DB } from '@zamfono/shared';

import { targetSecretSchema } from './_secret.js';

export type BackupTargetRow = Selectable<DB['backupTargets']>;
export type BackupRunRow = Selectable<DB['backupRuns']>;

/** Restic backend kinds a `backup_targets` row may name (§6.5 "Backups"). */
export const TARGET_KINDS = [
  'local',
  'ftp',
  'ftps',
  'sftp',
  's3',
  'webdav'
] as const;

/**
 * The fields `backups.targets.create` takes and `backups.targets.update` takes each optionally
 * (§6.5 "Backups"). `params` becomes `params_json`, free-form per kind; `secret` is
 * sealed into `secret_enc`.
 */
export const targetFields = {
  kind: z
    .enum(TARGET_KINDS)
    .describe(
      'The restic backend: local (a host path or volume), ftp, ftps, sftp, s3 or webdav.'
    ),
  params: z
    .record(z.string(), z.unknown())
    .describe(
      'The repository location per kind: local { path }, s3 { endpoint, bucket, path? }, sftp { host, path }, ftp and ftps { host, path? }, webdav { url, path? }; optional forget { keepDaily, keepWeekly, keepMonthly }, default 7/4/6.'
    ),
  secret: targetSecretSchema,
  enabled: z
    .boolean()
    .optional()
    .describe(
      'Whether scheduled runs back up to this target; on for a new one.'
    )
};

/** The restic forget policy applied when a target's `params_json` names none (§6.5). */
export const DEFAULT_FORGET_POLICY: Record<string, number> = {
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 6
};

/** `params` with the restic forget policy defaulted to 7 daily/4 weekly/6 monthly (§6.5) when absent. */
export function withDefaultForgetPolicy(
  params: Record<string, unknown>
): Record<string, unknown> {
  return 'forget' in params
    ? params
    : { ...params, forget: DEFAULT_FORGET_POLICY };
}

export type BackupTargetWire = {
  id: string;
  kind: (typeof TARGET_KINDS)[number];
  params: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
};

/** `row` as the API returns it; the secret is write-only and never appears here (§5.4). */
export function targetToWire(row: BackupTargetRow): BackupTargetWire {
  return {
    id: row.id,
    kind: row.kind as (typeof TARGET_KINDS)[number],
    params: JSON.parse(row.paramsJson) as Record<string, unknown>,
    enabled: row.enabled === 1,
    createdAt: row.createdAt
  };
}

/** Loads a live `backup_targets` row by id, or `undefined` when absent or soft-deleted. */
export async function loadLiveTarget(
  db: Db,
  id: string
): Promise<BackupTargetRow | undefined> {
  return db
    .selectFrom('backupTargets')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
}

export type BackupRunWire = {
  id: string;
  targetId: string;
  status: 'failed' | 'ok' | 'running';
  snapshotId: string | null;
  // §6.5: what the run uploaded after deduplication, and the snapshot's full size.
  bytesAdded: number | null;
  bytesTotal: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export function runToWire(row: BackupRunRow): BackupRunWire {
  return {
    id: row.id,
    targetId: row.targetId,
    status: row.status as 'failed' | 'ok' | 'running',
    snapshotId: row.snapshotId,
    bytesAdded: row.bytesAdded,
    bytesTotal: row.bytesTotal,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  };
}
