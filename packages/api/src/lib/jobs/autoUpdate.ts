/**
 * The automatic update (§6.3 "Updates"). While `settings.auto_update` is on, a newer non-breaking
 * release the updater reports is installed once the maintenance gate opens (`maintenanceWindow.ts`):
 * a backup of every enabled target first, then the request `system.update` makes
 * (`requestUpdate`). Its outcome is followed up once the updater reports the run ended, which is
 * after `api` itself restarted. A failure, of the backup, of the request or of the run, is
 * reported (`autoUpdateReport.ts`), and the release is tried again at a later maintenance moment
 * (`retryHeldOff`) until `MAX_AUTO_UPDATE_ATTEMPTS` attempts on it failed; a refusal because an
 * update is already running is no failed attempt. Whatever the setting, a breaking release, which
 * only `update.sh` on the host installs, is reported too.
 */
import pino from 'pino';

import { MINUTES_PER_HOUR, nowIso, type Db } from '@zamfono/shared';

import type { SendUpdateMail } from '../mail/owners.js';
import type { BackupRunRow } from '../ops/backups/_shared.js';
import { JOB_CALLER } from '../ops/outcomeLog.js';
import { requestUpdate } from '../ops/system/_request.js';
import {
  autoUpdateEnabled,
  loadUpdateState,
  retryHeldOff,
  type UpdateStateRow
} from '../ops/system/_state.js';
import type { UpdaterClient, UpdaterStatus } from '../ops/system/_updater.js';
import { OpError } from '../ops/types.js';
import {
  announceBreaking,
  audit,
  clearFailureAfterSuccess,
  followUpRun,
  reportFailure,
  type Attempt
} from './autoUpdateReport.js';
import { IDLE_RECHECK_MS, type MaintenanceGate } from './maintenanceWindow.js';

const logger = pino({ name: 'autoUpdate' });

const MS_PER_MINUTE = 60_000;
/** How often the job asks the updater, whose own lookup of the latest release is cached an hour. */
const POLL_INTERVAL_MS = MINUTES_PER_HOUR * MS_PER_MINUTE;

export type AutoUpdateDeps = {
  db: Db;
  /** Backs up every enabled target and returns the runs (`backupEnabledTargets`). */
  backUp: () => Promise<BackupRunRow[]>;
  gate: MaintenanceGate;
  updater: () => UpdaterClient | undefined;
  send: SendUpdateMail;
  now?: () => Date;
};

/** The release to install now, when the setting, the updater and the failed attempts allow one. */
async function wantedRelease(
  db: Db,
  row: UpdateStateRow,
  status: UpdaterStatus,
  now: Date
): Promise<string | null> {
  const version = status.latest?.version;
  if (
    version === undefined ||
    !status.updatable ||
    status.last.state === 'running' ||
    retryHeldOff(row, version, now)
  ) {
    return null;
  }
  return (await autoUpdateEnabled(db)) ? version : null;
}

/** Whether the updater runs an update now, one started by hand or on the host meanwhile. */
async function updaterBusy(deps: AutoUpdateDeps): Promise<boolean> {
  const status = await deps
    .updater()
    ?.status()
    .catch(() => undefined);
  return status?.last.state === 'running';
}

/**
 * Backs up every enabled target, then asks the updater for `attempt.to`; a failure is reported.
 * A refusal while another update runs is only audited: the release is wanted again once it ended.
 */
async function install(deps: AutoUpdateDeps, attempt: Attempt): Promise<void> {
  const runs = await deps.backUp();
  const failed = runs.find(run => run.status !== 'ok');
  if (runs.length === 0 || failed !== undefined) {
    const reason =
      failed === undefined
        ? 'no backup target is enabled'
        : `the backup to target ${failed.targetId} failed: ${failed.error ?? 'unknown error'}`;
    await reportFailure(deps, { ...attempt, outcome: 'backupFailed', reason });
    return;
  }
  try {
    await requestUpdate(deps.db, nowIso(), attempt.to, {
      trigger: 'automatic',
      by: JOB_CALLER.actor.name
    });
  } catch (error) {
    if (!(error instanceof OpError)) {
      throw error;
    }
    const reason = error.message;
    if (await updaterBusy(deps)) {
      await audit(deps.db, { ...attempt, outcome: 'refused', reason });
      return;
    }
    await reportFailure(deps, { ...attempt, outcome: 'refused', reason });
    return;
  }
  await audit(deps.db, { ...attempt, outcome: 'started' });
}

/**
 * One pass: follows up the automatic run `api` started, reports a breaking release, and installs
 * a wanted release once the gate opens. Resolves to when the job is worth running again sooner
 * than its hourly poll, `null` for no sooner.
 */
export async function runAutoUpdatePass(
  deps: AutoUpdateDeps
): Promise<Date | null> {
  const client = deps.updater();
  const row = await loadUpdateState(deps.db);
  if (client === undefined || row === undefined) {
    return null;
  }
  const status = await client.status();
  const now = (deps.now ?? (() => new Date()))();
  const soon = new Date(now.getTime() + IDLE_RECHECK_MS);
  if (await followUpRun(deps, row, status)) {
    return soon;
  }
  await clearFailureAfterSuccess(deps.db, row, status);
  await announceBreaking(deps, row, status);
  const fresh = (await loadUpdateState(deps.db)) ?? row;
  const to = await wantedRelease(deps.db, fresh, status, now);
  if (to === null) {
    deps.gate.reset();
    return null;
  }
  const verdict = await deps.gate.check(now);
  if (!verdict.open) {
    return verdict.nextCheckAt;
  }
  await install(deps, { from: status.current ?? '', to });
  return soon;
}

export type AutoUpdateScheduler = { stop: () => void };

/**
 * Runs `runAutoUpdatePass` at `api` start, which follows up a run that restarted `api`, and then
 * hourly, drawn in to land on the gate's next check or a run's follow-up whenever that falls
 * sooner. A pass that fails is logged; the next one retries.
 */
export function scheduleAutoUpdate(deps: AutoUpdateDeps): AutoUpdateScheduler {
  const now = deps.now ?? (() => new Date());
  const state: { timer?: NodeJS.Timeout; stopped: boolean } = {
    stopped: false
  };
  const tick = (): void => {
    runAutoUpdatePass(deps)
      .catch((error: unknown) => {
        logger.warn({ error }, 'autoUpdate: the pass failed; the next retries');
        return null;
      })
      .then(next => {
        if (state.stopped) {
          return;
        }
        const delayMs =
          next === null
            ? POLL_INTERVAL_MS
            : Math.min(
                POLL_INTERVAL_MS,
                Math.max(0, next.getTime() - now().getTime())
              );
        state.timer = setTimeout(tick, delayMs);
      })
      .catch(() => undefined);
  };
  tick();
  return {
    stop: () => {
      state.stopped = true;
      clearTimeout(state.timer);
    }
  };
}
