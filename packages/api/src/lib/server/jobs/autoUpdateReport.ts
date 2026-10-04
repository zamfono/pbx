/**
 * What the automatic update (`autoUpdate.ts`) reports (§6.3 "Updates"): every attempt and
 * outcome as an audit entry `system.autoUpdate` on channel `job` (§5.7), a failure for `/healthz`,
 * `/metrics` and `system.info`, the last attempt a release gets in a mail to the owners, and a
 * breaking release for `/metrics` and in one mail to the owners per release.
 */
import type { Db, UpdaterStatus } from '@zamfono/shared';

import { mailOwners, type SendUpdateMail } from '../mail/owners.js';
import {
  JOB_CALLER,
  outcomeChanges,
  recordOutcome
} from '../ops/outcomeLog.js';
import {
  autoUpdateFailure,
  loadUpdateState,
  MAX_AUTO_UPDATE_ATTEMPTS,
  setAutoUpdateFailure,
  type UpdateStateRow
} from '../ops/system/_state.js';

export type ReportDeps = { db: Db; send: SendUpdateMail; now?: () => Date };

export type Outcome =
  | 'started'
  | 'noBackupTarget'
  | 'backupFailed'
  | 'busy'
  | 'refused'
  | 'succeeded'
  | 'failed';

/** One attempt or outcome: the versions its audit entry carries, and the release its failure
 * counts on (`attemptedRelease`). */
export type Attempt = { from: string; to: string; release: string };

export async function audit(
  db: Db,
  { from, to, outcome, reason }: Attempt & { outcome: Outcome; reason?: string }
): Promise<void> {
  await recordOutcome(db, {
    caller: JOB_CALLER,
    operation: 'system.autoUpdate',
    entity: { kind: 'system', id: null },
    changes: outcomeChanges({ from, to, outcome, reason })
  });
}

/**
 * Records a failed attempt on `to`, counted with the earlier ones on that release, and audits it.
 * The owners are mailed once per release, when its last attempt failed: the failures before it are
 * on `/healthz` and in `system.info` already, and mailing each would repeat the same news daily.
 */
export async function reportFailure(
  deps: ReportDeps,
  attempt: Attempt & { outcome: Outcome; reason: string }
): Promise<void> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const previous = autoUpdateFailure(await loadUpdateState(deps.db));
  const attempts =
    previous?.version === attempt.release ? previous.attempts + 1 : 1;
  await setAutoUpdateFailure(deps.db, {
    version: attempt.release,
    reason: attempt.reason,
    at,
    attempts
  });
  await audit(deps.db, attempt);
  if (attempts < MAX_AUTO_UPDATE_ATTEMPTS) {
    return;
  }
  await mailOwners(deps.db, deps.send, userId => ({
    kind: 'updateFailed',
    to: { userId },
    values: {
      fromVersion: attempt.from,
      toVersion: attempt.to,
      reason: attempt.reason,
      failedAt: at
    }
  }));
}

/**
 * The outcome of the automatic run `api` started, once the updater reports it ended; `true` while
 * it still runs, so the job looks again soon. A run the updater does not report, its record lost
 * with its `.update/` or kept without its versions, leaves nothing to follow up.
 */
export async function followUpRun(
  deps: ReportDeps,
  row: UpdateStateRow,
  status: UpdaterStatus
): Promise<boolean> {
  const release = row.runRelease;
  if (release === null) {
    return false;
  }
  const { last } = status;
  if (last.startedAt === row.runStartedAt && last.state === 'running') {
    return true;
  }
  await deps.db
    .updateTable('updateState')
    .set({ runRelease: null })
    .where('id', '=', 1)
    .execute();
  const { from, to } = last;
  if (
    last.startedAt !== row.runStartedAt ||
    from === undefined ||
    to === undefined
  ) {
    return false;
  }
  const attempt = { from, to, release };
  if (last.state === 'succeeded') {
    await audit(deps.db, { ...attempt, outcome: 'succeeded' });
    return false;
  }
  await reportFailure(deps, {
    ...attempt,
    outcome: 'failed',
    reason:
      last.error ?? 'the updater reported the run failed without naming why'
  });
  return false;
}

/** A recorded failure ends with any update that succeeded after it, manual ones included. */
export async function clearFailureAfterSuccess(
  db: Db,
  row: UpdateStateRow,
  status: UpdaterStatus
): Promise<void> {
  const failure = autoUpdateFailure(row);
  const { last } = status;
  if (
    failure !== null &&
    last.state === 'succeeded' &&
    last.finishedAt !== undefined &&
    last.finishedAt > failure.at
  ) {
    await setAutoUpdateFailure(db, null);
  }
}

/**
 * Records the breaking release the updater reports, or that there is none, for `/metrics`, and
 * mails the owners once per release. A failed lookup tells nothing and changes nothing.
 */
export async function announceBreaking(
  deps: ReportDeps,
  row: UpdateStateRow,
  status: UpdaterStatus,
  currentVersion: string
): Promise<void> {
  if (status.latestError !== undefined) {
    return;
  }
  const latest = status.breaking ? status.latest : null;
  const version = latest?.version ?? null;
  const announce = latest !== null && latest.version !== row.breakingAnnounced;
  if (version === row.breakingVersion && !announce) {
    return;
  }
  await deps.db
    .updateTable('updateState')
    .set({
      breakingVersion: version,
      ...(announce ? { breakingAnnounced: version } : {})
    })
    .where('id', '=', 1)
    .execute();
  if (!announce) {
    return;
  }
  await mailOwners(deps.db, deps.send, userId => ({
    kind: 'breakingUpdate',
    to: { userId },
    values: {
      currentVersion,
      version: latest.version,
      releaseUrl: latest.url,
      publishedAt: latest.publishedAt
    }
  }));
}
