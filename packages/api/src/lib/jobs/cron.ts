/** Cron-expression scheduling for the backup job (§6.5 "Backups"). */
import pino from 'pino';

import { nowIso, type Db } from '@zamfono/shared';

import { loadLiveTarget, type BackupRunRow } from '../ops/backups/_shared.js';
import { loadSettings } from '../ops/settings/_shared.js';
import { type Keyring } from '../secretbox.js';
import { tenantTimeZone } from '../tenantTimeZone.js';
import {
  createBackupRun,
  failBackupRun,
  performBackup,
  type BackupJobDeps
} from './backup.js';
import { nextRun } from './cronExpression.js';

const logger = pino({ name: 'backup-cron' });
// The schedule loop retries after this fixed delay on a failed cycle (a transient `loadSettings`
// error, a `backup_cron` stored before `settings.update` validated it), for the life of the process.
const SCHEDULE_RETRY_DELAY_MS = 60_000;
// How often the scheduler looks for runs queued elsewhere. `backups.runs.start` runs in the
// SvelteKit bundle and this scheduler in the `server.ts` bundle; the two are separate builds with
// their own copy of every module, so `backup_runs` itself is the queue between them.
const QUEUE_POLL_INTERVAL_MS = 5_000;

/**
 * Runs `run` through to `ok` or `failed` (§6.5). A run whose target has been deleted between the
 * queueing and now ends as `failed`, since a restic repository is reachable only through the
 * target's credentials.
 */
async function executeRun(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps,
  run: BackupRunRow
): Promise<void> {
  const target = await loadLiveTarget(db, run.targetId);
  if (target) {
    await performBackup(db, kr, run, target, deps);
    return;
  }
  await failBackupRun(
    db,
    deps,
    run,
    `backup: target '${run.targetId}' not found`
  );
}

/** Opens a run of `targetId`, marks it started by this process, and executes it. */
async function runTarget(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps,
  started: Set<string>,
  targetId: string
): Promise<void> {
  const { run, target } = await createBackupRun(db, targetId, deps);
  started.add(run.id);
  await performBackup(db, kr, run, target, deps);
}

async function runEnabledTargets(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps,
  started: Set<string>
): Promise<void> {
  const targets = await db
    .selectFrom('backupTargets')
    .select('id')
    .where('enabled', '=', 1)
    .where('deletedAt', 'is', null)
    .execute();
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; runs must serialize
    await runTarget(db, kr, deps, started, target.id).catch(
      (error: unknown) => {
        // The failure already lives in the run row and `backup.failed` event; this is a trace.
        logger.error(
          { error, targetId: target.id },
          'scheduled backup run failed'
        );
      }
    );
  }
}

/**
 * Executes every `running` `backup_runs` row started at or after `since` that this process did
 * not start itself: the manual runs `backups.runs.start` committed (§6.5). Rows started before
 * `since` belong to an earlier process and are the boot sweep's (`markInterruptedRuns`).
 */
async function runQueued(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps,
  started: Set<string>,
  since: string
): Promise<void> {
  const queued = await db
    .selectFrom('backupRuns')
    .selectAll()
    .where('status', '=', 'running')
    .where('startedAt', '>=', since)
    .execute();
  for (const run of queued) {
    if (started.has(run.id)) {
      continue;
    }
    started.add(run.id);
    // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; runs must serialize
    await executeRun(db, kr, deps, run).catch((error: unknown) => {
      // The failure already lives in the run row and `backup.failed` event; this is a trace.
      logger.error({ error, runId: run.id }, 'queued backup run failed');
    });
  }
}

/**
 * Fails every `backup_runs` row still `running`, error `interrupted` (§6.5): a prior process's
 * run. `startedBefore`, when given, excludes a row started at or after that moment — a run
 * queued by this same process after it started, not one an earlier process left behind.
 */
export async function markInterruptedRuns(
  db: Db,
  now: () => string = nowIso,
  startedBefore?: string
): Promise<number> {
  let query = db
    .updateTable('backupRuns')
    .set({ status: 'failed', error: 'interrupted', finishedAt: now() })
    .where('status', '=', 'running');
  if (startedBefore !== undefined) {
    query = query.where('startedAt', '<', startedBefore);
  }
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/**
 * Resolves after `ms`, or immediately once `signal` aborts (a fresh, local timer per call). The
 * abort listener is removed on the timer path too, since `signal` is the long-lived scheduler
 * signal and outlives any single call.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer: { id?: NodeJS.Timeout } = {};
    const onAbort = (): void => {
      clearTimeout(timer.id);
      resolve();
    };
    timer.id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export type BackupScheduler = { stop(): void };

/**
 * Sweeps runs an earlier process left `running`, polls `backup_runs` for the runs
 * `backups.runs.start` queues, and loops the automatic runs from `settings.backup_cron`, re-read
 * every cycle so a change takes effect on the following one (§6.5).
 */
export function scheduleBackups(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps,
  queuePollIntervalMs: number = QUEUE_POLL_INTERVAL_MS
): BackupScheduler {
  // Captured before the first poll can pick a run up, so the boot sweep and the queue poll
  // partition `backup_runs` between them along the same instant.
  const bootAt = (deps.now ?? nowIso)();
  // The ids of the runs this process opened itself, which the queue poll therefore skips.
  const started = new Set<string>();
  markInterruptedRuns(db, deps.now, bootAt).catch((error: unknown) => {
    // Best-effort boot sweep; a run left `running` is retried by the operator, not by this job.
    logger.error({ error }, 'failed to sweep interrupted backup runs at boot');
  });

  const stopper = new AbortController();
  const queueLoop = async (): Promise<void> => {
    while (!stopper.signal.aborted) {
      // eslint-disable-next-line no-await-in-loop -- one queue cycle finishes before the next
      await runQueued(db, kr, deps, started, bootAt).catch((error: unknown) => {
        logger.error({ error }, 'backup queue poll failed');
      });
      // eslint-disable-next-line no-await-in-loop -- a fixed interval between polls
      await delay(queuePollIntervalMs, stopper.signal);
    }
  };
  const loop = async (): Promise<void> => {
    while (!stopper.signal.aborted) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each cycle re-reads the cron setting live
        const settings = await loadSettings(db);
        const timezone = tenantTimeZone(settings.timezone);
        const due = nextRun(settings.backupCron, timezone, new Date());
        // eslint-disable-next-line no-await-in-loop -- each cycle waits out its own scheduled delay
        await delay(Math.max(0, due.getTime() - Date.now()), stopper.signal);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() can abort during the delay above, which TS can't see
        if (stopper.signal.aborted) {
          return;
        }
        // eslint-disable-next-line no-await-in-loop -- one run cycle finishes before the next is due
        await runEnabledTargets(db, kr, deps, started);
      } catch (error) {
        // The loop retries after a fixed backoff on any cycle failure, for the process's life.
        logger.error(
          { error },
          'backup schedule cycle failed; retrying after a delay'
        );
        // eslint-disable-next-line no-await-in-loop -- a fixed backoff before the next attempt
        await delay(SCHEDULE_RETRY_DELAY_MS, stopper.signal);
      }
    }
  };
  loop().catch((error: unknown) => {
    logger.error({ error }, 'backup schedule loop stopped unexpectedly');
  });
  queueLoop().catch((error: unknown) => {
    logger.error({ error }, 'backup queue loop stopped unexpectedly');
  });

  return {
    stop() {
      stopper.abort();
    }
  };
}
