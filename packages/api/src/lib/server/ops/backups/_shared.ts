import { isDeepStrictEqual } from 'node:util';
import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  BACKUP_RUN_STATUSES,
  BACKUP_TARGET_KINDS,
  backupParamsColumn,
  backupParamsSchema,
  HTTP_UNPROCESSABLE_CONTENT,
  type Db,
  type DB
} from '@zamfono/shared';

import { assertValidHost } from '../trunks/hostValidation.js';
import { OpError } from '../types.js';
import { targetSecretSchema } from './_secret.js';

export type BackupTargetRow = Selectable<DB['backupTargets']>;
export type BackupRunRow = Selectable<DB['backupRuns']>;

/**
 * The fields `backups.targets.create` takes and `backups.targets.update` takes each optionally
 * (§6.5 "Backups"). `params` becomes `params_json`, free-form per kind; `secret` is
 * sealed into `secret_enc`.
 */
export const targetFields = {
  kind: z
    .enum(BACKUP_TARGET_KINDS)
    .describe(
      'The restic backend: local (a directory under /backups), ftp, ftps, sftp, s3 or webdav.'
    ),
  params: backupParamsSchema.describe(
    'The repository location per kind: local { path }, /backups or a path below it, s3 { endpoint, bucket, path? }, sftp { host, path }, ftp and ftps { host, path? }, webdav { url, path? }; optional forget { keepDaily, keepWeekly, keepMonthly }, default 7/4/6. Changing the kind or any field but forget needs the secret again.'
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

/** The volume local targets live on (§6.5 "Target kinds"): another disk is mounted below it. */
export const LOCAL_BACKUP_ROOT = '/backups';

/**
 * Throws 422 unless `path` is an absolute path that is `/backups` or lies below it, with no `..`
 * segment (refused rather than resolved), so restic takes it as a plain directory: no backend
 * prefix (`sftp:`, `rest:`, `rclone:`, `local:`) and no other state of the stack (§6.5).
 */
export function assertLocalPath(path: unknown): void {
  const fits =
    typeof path === 'string' &&
    !path.split('/').includes('..') &&
    (path === LOCAL_BACKUP_ROOT || path.startsWith(`${LOCAL_BACKUP_ROOT}/`));
  if (!fits) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `backups: a local target's path is ${LOCAL_BACKUP_ROOT} or a path below it, without ..`
    );
  }
}

/**
 * Throws 422 unless a `kind` target's `params` name its server as the backend can take it
 * (§6.5 "Target kinds"): an sftp, ftp or ftps `host` is an FQDN or an IPv4 address, so it can
 * never reach ssh as an option, a webdav `url` is an `http` or `https` URL, and a local `path`
 * lies under `/backups` (`assertLocalPath`).
 */
export function assertParamsFitKind(
  kind: string,
  params: Record<string, unknown>
): void {
  if (kind === 'local') {
    assertLocalPath(params.path);
  }
  if (kind === 'sftp' || kind === 'ftp' || kind === 'ftps') {
    assertValidHost(typeof params.host === 'string' ? params.host : '', 'both');
  }
  if (kind === 'webdav') {
    const url = typeof params.url === 'string' ? URL.parse(params.url) : null;
    if (url?.protocol !== 'https:' && url?.protocol !== 'http:') {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'backups: a webdav target needs an http or https url'
      );
    }
  }
}

/**
 * Throws 422 when an update moves a target elsewhere, a new `kind` or any `params` field but the
 * `forget` policy differing from the stored one, without a new secret (§5.4): the stored backend
 * credentials must not follow the target to a location they were not given for.
 */
export function assertRepointCarriesSecret(
  before: { kind: string; params: Record<string, unknown> },
  after: { kind: string; params: Record<string, unknown> },
  secretGiven: boolean
): void {
  const keys = new Set([
    ...Object.keys(before.params),
    ...Object.keys(after.params)
  ]);
  keys.delete('forget');
  const moved =
    before.kind !== after.kind ||
    [...keys].some(
      key => !isDeepStrictEqual(before.params[key], after.params[key])
    );
  if (moved && !secretGiven) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      "backups: a new kind or location needs the target's secret again"
    );
  }
}

/** A backup target's wire shape (§6.5 "Backups"). */
export const backupTargetWire = z.object({
  id: z.string(),
  kind: z.enum(BACKUP_TARGET_KINDS),
  params: backupParamsSchema,
  secretSet: z
    .literal(true)
    .describe(
      "Always true: a target's secret is required; the secret itself is write-only (§10.3)."
    ),
  enabled: z.boolean(),
  createdAt: z.string()
});
export type BackupTargetWire = z.infer<typeof backupTargetWire>;

/** `row` as the API returns it; the secret is write-only, only `secretSet` shows it (§10.3). */
export function targetToWire(row: BackupTargetRow): BackupTargetWire {
  return {
    id: row.id,
    kind: row.kind,
    params: backupParamsColumn.decode(row.paramsJson),
    secretSet: true,
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

/** A backup run's wire shape (§6.5 "Backups"). */
export const backupRunWire = z.object({
  id: z.string(),
  targetId: z.string(),
  status: z.enum(BACKUP_RUN_STATUSES),
  snapshotId: z.string().nullable(),
  bytesAdded: z
    .number()
    .nullable()
    .describe('What the run uploaded after deduplication, in bytes.'),
  bytesTotal: z
    .number()
    .nullable()
    .describe("The snapshot's full size, in bytes."),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable()
});
export type BackupRunWire = z.infer<typeof backupRunWire>;

export function runToWire(row: BackupRunRow): BackupRunWire {
  return {
    id: row.id,
    targetId: row.targetId,
    status: row.status,
    snapshotId: row.snapshotId,
    bytesAdded: row.bytesAdded,
    bytesTotal: row.bytesTotal,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  };
}
