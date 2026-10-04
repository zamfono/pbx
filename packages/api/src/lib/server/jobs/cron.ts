/**
 * Cron-expression scheduling for the backup job (§6.5 "Backups"), and the manual runs' queue;
 * both wait their turn with the automatic update's backup (`backupTurns.ts`).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';

import { MAX_TIMER_MS, nowIso, type Db } from '@zamfono/shared';

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
import { enabledTargetIds, inTurn } from './backupTurns.js';
import { nextRun } from './cronExpression.js';

const logger = pino({ name: 'backup-cron' });
// The schedule loop retries after this fixed delay on a failed cycle (a transient `loadSettings`
// error, a `backup_cron` stored before `settings.update` validated it), for the life of the process.
const SCHEDULE_RETRY_DELAY_MS = 60_000;

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

/** Opens a run of `targetId` and executes it. */
async function runTarget(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps,
  targetId: string
): Promise<void> {
  const { run, target } = await createBackupRun(db, targetId, deps);
  await performBackup(db, kr, run, target, deps);
}

async function runEnabledTargets(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps
): Promise<void> {
  for (const targetId of await enabledTargetIds(db)) {
    // eslint-disable-next-line no-await-in-loop -- backup runs take turns: one target's run ends before the next one starts
    await runTarget(db, kr, deps, targetId).catch((error: unknown) => {
      // The failure already lives in the run row and `backup.failed` event; this is a trace.
      logger.error({ error, targetId }, 'scheduled backup run failed');
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
 * Resolves after `ms`, or at once when `signal` aborts: a stop, which the loop checks next, so
 * the rejection an abort gives is no failure.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, undefined, { signal }).catch(() => undefined);
}

export type BackupScheduler = {
  /** Executes a manual run `backups.runs.start` committed, after the ones queued before it. */
  enqueue(run: BackupRunRow): void;
  stop(): void;
};

// The scheduler this process runs, for `backups.runs.start` to hand its runs to (`queueRun`).
let activeScheduler: BackupScheduler | undefined;

/**
 * Hands a committed manual run to this process's scheduler; `false` while none runs (a unit test,
 * `vite dev` without a keyring), where the run stays `running` until the next boot sweep fails it.
 */
export function queueRun(run: BackupRunRow): boolean {
  if (activeScheduler === undefined) {
    return false;
  }
  activeScheduler.enqueue(run);
  return true;
}

/** The manual runs' queue: one at a time, in the order they were committed. */
function manualRunQueue(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps
): (run: BackupRunRow) => void {
  return run => {
    inTurn(async () => executeRun(db, kr, deps, run)).catch(
      (error: unknown) => {
        // The failure already lives in the run row and `backup.failed` event; this is a trace.
        logger.error({ error, runId: run.id }, 'queued backup run failed');
      }
    );
  };
}

/**
 * Sweeps runs an earlier process left `running`, executes the runs `backups.runs.start` hands
 * over (`queueRun`), and loops the automatic runs from `settings.backup_cron`, re-read every
 * cycle so a change takes effect on the following one (§6.5).
 */
export function scheduleBackups(
  db: Db,
  kr: Keyring,
  deps: BackupJobDeps
): BackupScheduler {
  // A run this process queues is started at or after this instant, which the boot sweep, not
  // awaited, therefore leaves alone.
  const bootAt = (deps.now ?? nowIso)();
  markInterruptedRuns(db, deps.now, bootAt).catch((error: unknown) => {
    // Best-effort boot sweep; a run left `running` is retried by the operator, not by this job.
    logger.error({ error }, 'failed to sweep interrupted backup runs at boot');
  });

  const stopper = new AbortController();
  const loop = async (): Promise<void> => {
    while (!stopper.signal.aborted) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each cycle re-reads the cron setting live
        const settings = await loadSettings(db);
        const timezone = tenantTimeZone(settings.timezone);
        const due = nextRun(settings.backupCron, timezone, new Date());
        const waitMs = due.getTime() - Date.now();
        // eslint-disable-next-line no-await-in-loop -- each cycle waits out its own scheduled delay
        await delay(
          Math.min(Math.max(0, waitMs), MAX_TIMER_MS),
          stopper.signal
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() can abort during the delay above, which TS can't see
        if (stopper.signal.aborted) {
          return;
        }
        // A run further away than one timer reaches is waited for in slices, each re-checked.
        if (Date.now() < due.getTime()) {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- one run cycle finishes before the next is due
        await inTurn(async () => runEnabledTargets(db, kr, deps));
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

  const scheduler: BackupScheduler = {
    enqueue: manualRunQueue(db, kr, deps),
    stop() {
      stopper.abort();
      if (activeScheduler === scheduler) {
        activeScheduler = undefined;
      }
    }
  };
  activeScheduler = scheduler;
  return scheduler;
}
