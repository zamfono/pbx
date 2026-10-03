/**
 * The automatic update (§6.3 "Updates"). While `settings.auto_update` is on, a newer non-breaking
 * release the updater reports is installed once the maintenance gate opens (`maintenanceWindow.ts`):
 * a backup of every enabled target first, then the request `system.update` makes
 * (`requestUpdate`). Its outcome is followed up once the updater reports the run ended, which is
 * after `api` itself restarted. A failure, of the backup, of the request or of the run, is
 * reported (`autoUpdateReport.ts`), and the release is tried again at a later maintenance moment
 * (`retryHeldOff`) until `MAX_AUTO_UPDATE_ATTEMPTS` attempts on it failed; a gate that gave up
 * `GIVE_UPS_PER_ATTEMPT` maintenance moments in a row is a failed attempt too, and a refusal
 * because an update is already running is none. Whatever the setting, a breaking release, which
 * only `update.sh` on the host installs, is reported too.
 */
import pino from 'pino';

import { nowIso, type Db, type UpdaterStatus } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';

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
import type { UpdaterClient } from '../ops/system/_updater.js';
import { OpError } from '../ops/types.js';
import {
  announceBreaking,
  audit,
  clearFailureAfterSuccess,
  followUpRun,
  reportFailure,
  type Attempt
} from './autoUpdateReport.js';
import { scheduleDrawnIn } from './drawnIn.js';
import {
  IDLE_RECHECK_MS,
  type GateCheck,
  type MaintenanceGate
} from './maintenanceWindow.js';

const logger = pino({ name: 'autoUpdate' });

/** How many maintenance moments in a row the gate may give up before that is a failed attempt. */
export const GIVE_UPS_PER_ATTEMPT = 3;

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

/** The runs of a backup of every enabled target, or why it could not run at all. */
async function backUp(
  deps: AutoUpdateDeps
): Promise<BackupRunRow[] | { error: string }> {
  try {
    return await deps.backUp();
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/**
 * Backs up every enabled target, then asks the updater for `attempt.to`; a failure is reported.
 * A refusal while another update runs is only audited: the release is wanted again once it ended.
 */
async function install(deps: AutoUpdateDeps, attempt: Attempt): Promise<void> {
  const runs = await backUp(deps);
  if (!Array.isArray(runs)) {
    const reason = `the backup failed: ${runs.error}`;
    await reportFailure(deps, { ...attempt, outcome: 'backupFailed', reason });
    return;
  }
  if (runs.length === 0) {
    const reason = 'no enabled backup target';
    await reportFailure(deps, {
      ...attempt,
      outcome: 'noBackupTarget',
      reason
    });
    return;
  }
  const failed = runs.find(run => run.status !== 'ok');
  if (failed !== undefined) {
    const reason = `the backup to target ${failed.targetId} failed: ${failed.error ?? 'without an error message'}`;
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
 * A failed attempt once the gate gave up `GIVE_UPS_PER_ATTEMPT` maintenance moments in a row,
 * which then starts its count afresh; `true` when it was one.
 */
async function reportGiveUps(
  deps: AutoUpdateDeps,
  attempt: Attempt,
  verdict: GateCheck
): Promise<boolean> {
  const gaveUp = verdict.open ? undefined : verdict.gaveUp;
  if (gaveUp === undefined || gaveUp.inARow < GIVE_UPS_PER_ATTEMPT) {
    return false;
  }
  const reason = `the system was busy at ${String(GIVE_UPS_PER_ATTEMPT)} maintenance moments in a row, at the last ${gaveUp.reason}`;
  await reportFailure(deps, { ...attempt, outcome: 'busy', reason });
  await deps.gate.reset();
  return true;
}

// Whether the updater's unknown current release was logged since it was last known.
let unknownCurrentLogged = false;

/** Logs once, until the updater knows the current release again, why a pass does nothing. */
function logUnknownCurrentOnce(): void {
  if (!unknownCurrentLogged) {
    logger.warn(
      'autoUpdate: the updater knows no current release, so nothing is attempted or reported'
    );
    unknownCurrentLogged = true;
  }
}

/**
 * One pass: follows up the automatic run `api` started, reports a breaking release, and installs
 * a wanted release once the gate opens; nothing while the updater knows no current release. Resolves to when the job is worth running again sooner
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
  const from = status.current;
  if (from === null) {
    logUnknownCurrentOnce();
    return null;
  }
  unknownCurrentLogged = false;
  const now = (deps.now ?? (() => new Date()))();
  const soon = new Date(now.getTime() + IDLE_RECHECK_MS);
  if (await followUpRun(deps, row, status)) {
    return soon;
  }
  await clearFailureAfterSuccess(deps.db, row, status);
  await announceBreaking(deps, row, status, from);
  const fresh = (await loadUpdateState(deps.db)) ?? row;
  const to = await wantedRelease(deps.db, fresh, status, now);
  if (to === null) {
    await deps.gate.reset();
    return null;
  }
  const attempt = { from, to };
  const verdict = await deps.gate.check(now);
  if (await reportGiveUps(deps, attempt, verdict)) {
    return null;
  }
  if (!verdict.open) {
    return verdict.nextCheckAt;
  }
  await install(deps, attempt);
  return soon;
}

export type AutoUpdateScheduler = { stop: () => void };

/**
 * Runs `runAutoUpdatePass` at `api` start, which follows up a run that restarted `api`, and then
 * hourly, drawn in to land on the gate's next check or a run's follow-up whenever that falls
 * sooner. A pass that fails is logged; the next one retries.
 */
export function scheduleAutoUpdate(deps: AutoUpdateDeps): AutoUpdateScheduler {
  return scheduleDrawnIn({
    pass: async () => runAutoUpdatePass(deps),
    failed: error => {
      logger.warn({ error }, 'autoUpdate: the pass failed; the next retries');
    },
    now: deps.now
  });
}
