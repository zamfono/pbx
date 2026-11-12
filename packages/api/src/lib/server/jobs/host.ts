/**
 * The host's upkeep (§6.3 "Host control"), only while `HOST_CONTROL` is `true`: the host's
 * unattended upgrades kept as `settings.host_updates` says, and a reboot through the maintenance
 * gate (`maintenanceWindow.ts`) once an owner scheduled one, or once the host waits for one and
 * `settings.auto_reboot` is on. A reboot also waits while a backup runs, and the updater refuses
 * one while an update runs; the pass then tries again soon.
 */
import pino from 'pino';

import type { Db, HostStatus } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';

import {
  JOB_CALLER,
  outcomeChanges,
  recordOutcome
} from '../ops/outcomeLog.js';
import {
  hostSettings,
  rebootRequest,
  setRebootRequest,
  setRebootRequiredSince
} from '../ops/system/_host.js';
import type { HostClient } from '../ops/system/_updater.js';
import { scheduleDrawnIn, type DrawnInSchedule } from './drawnIn.js';
import { IDLE_RECHECK_MS, type MaintenanceGate } from './maintenanceWindow.js';

const logger = pino({ name: 'host' });

export type HostJobDeps = {
  db: Db;
  gate: MaintenanceGate;
  host: () => HostClient | undefined;
  now?: () => Date;
};

/**
 * The host's upgrades as the setting says: a setting not yet set takes the host's own state,
 * which setup.sh chose; one that differs from the host is applied to it.
 */
async function keepUpdates(
  deps: HostJobDeps,
  client: HostClient,
  status: HostStatus
): Promise<void> {
  if (status.updates === null) {
    return;
  }
  const { hostUpdates } = await hostSettings(deps.db);
  if (hostUpdates === null) {
    await deps.db
      .updateTable('settings')
      .set({ hostUpdates: status.updates ? 1 : 0 })
      .where('id', '=', 1)
      .execute();
    return;
  }
  if (hostUpdates !== status.updates) {
    await client.setUpdates(hostUpdates);
  }
}

async function backupRunning(db: Db): Promise<boolean> {
  const run = await db
    .selectFrom('backupRuns')
    .select('id')
    .where('status', '=', 'running')
    .executeTakeFirst();
  return run !== undefined;
}

/**
 * Asks the updater for the reboot, the request dropped first, since the host may go down soon
 * after, and put back when the updater refuses; `true` once it began, which is audited.
 */
async function reboot(
  deps: HostJobDeps,
  client: HostClient,
  status: HostStatus
): Promise<boolean> {
  const request = await rebootRequest(deps.db);
  const changes = outcomeChanges({
    trigger: request === null ? 'automatic' : 'scheduled',
    ...(request === null ? {} : { by: request.by }),
    packages: status.rebootRequired?.packages ?? []
  });
  await setRebootRequest(deps.db, null);
  try {
    await client.reboot();
  } catch (error) {
    await setRebootRequest(deps.db, request);
    logger.warn(
      { err: error },
      `host: the reboot was refused: ${errorMessage(error)}; the next pass tries again`
    );
    return false;
  }
  await recordOutcome(deps.db, {
    caller: JOB_CALLER,
    operation: 'system.hostReboot',
    entity: { kind: 'system', id: null },
    changes
  });
  return true;
}

/** One pass; resolves to when the next is worth running sooner than the hourly poll. */
export async function runHostPass(deps: HostJobDeps): Promise<Date | null> {
  const client = deps.host();
  if (client === undefined) {
    return null;
  }
  const status = await client.read();
  await setRebootRequiredSince(deps.db, status.rebootRequired?.since ?? null);
  await keepUpdates(deps, client, status);
  const scheduled = (await rebootRequest(deps.db)) !== null;
  const automatic =
    status.rebootRequired !== null && (await hostSettings(deps.db)).autoReboot;
  if ((!scheduled && !automatic) || status.rebootRefused !== undefined) {
    await deps.gate.reset();
    return null;
  }
  const now = (deps.now ?? (() => new Date()))();
  const soon = new Date(now.getTime() + IDLE_RECHECK_MS);
  const verdict = await deps.gate.check(now);
  if (!verdict.open) {
    return verdict.nextCheckAt;
  }
  if (await backupRunning(deps.db)) {
    return soon;
  }
  return (await reboot(deps, client, status)) ? null : soon;
}

let schedule: DrawnInSchedule | undefined;

/** Runs `runHostPass` at `api` start and then hourly, drawn in like the automatic update's. */
export function scheduleHost(deps: HostJobDeps): { stop: () => void } {
  schedule = scheduleDrawnIn({
    pass: async () => runHostPass(deps),
    failed: error => {
      logger.warn({ err: error }, 'host: the pass failed; the next retries');
    },
    now: deps.now
  });
  return schedule;
}

/** A pass now, after an owner changed what the host should do; nothing before the job started. */
export function runHostPassNow(): void {
  schedule?.runNow();
}
