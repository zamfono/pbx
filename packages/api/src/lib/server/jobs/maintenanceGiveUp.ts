/**
 * What the maintenance gate (`maintenanceWindow.ts`, §6.4 "Maintenance gate") reports when it
 * gives up: what kept the system busy, as `core`'s live state counts it, in a log line, an audit
 * entry `system.maintenanceGate` on channel `job` (§5.7) and `maintenance_gate` (§11.2), which
 * also counts the maintenance moments given up in a row and which `system.info` reads.
 */
import pino from 'pino';

import type { Db, StateResponse } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';

import type { CoreClient } from '../coreClient.js';
import {
  JOB_CALLER,
  outcomeChanges,
  recordOutcome
} from '../ops/outcomeLog.js';

const logger = pino({ name: 'maintenanceGate' });

/** The work a gate holds back: the certificate swap (`certSync.ts`) or the automatic update. */
export type MaintenanceWork = 'certSync' | 'autoUpdate';

const WORK_LABELS: Record<MaintenanceWork, string> = {
  certSync: 'the certificate swap',
  autoUpdate: 'the automatic update'
};

/** What `core`'s live state counted in progress, or why it told nothing. */
export type Busy =
  | {
      liveCalls: number;
      asteriskChannels: number | null;
      recordingsInProgress: number;
    }
  | { coreError: string };

/**
 * `state`'s count of what is in progress, `null` when it shows the system idle: no call, no
 * channel Asterisk holds (a parked party, a voicemail deposit and a menu each hold one), no
 * recording being made or mixed. A state without `asteriskChannels`, from a `core` that does not
 * report it, or with `null` for it, while ARI does not answer, is never idle.
 */
export function busyOf(state: StateResponse): Busy | null {
  const asteriskChannels = state.asteriskChannels ?? null;
  const busy = {
    liveCalls: state.calls.length,
    asteriskChannels,
    recordingsInProgress: state.recordingsInProgress
  };
  const idle =
    busy.liveCalls === 0 &&
    asteriskChannels === 0 &&
    busy.recordingsInProgress === 0;
  return idle ? null : busy;
}

/** `busyOf` `core`'s live state; a `core` that does not answer is busy. */
export async function coreBusy(
  core: Pick<CoreClient, 'state'>
): Promise<Busy | null> {
  try {
    return busyOf(await core.state());
  } catch (error) {
    return { coreError: errorMessage(error) };
  }
}

/** `busy` in words, for the log, the audit entry and `system.info`. */
export function describeBusy(busy: Busy): string {
  if ('coreError' in busy) {
    return `core did not answer: ${busy.coreError}`;
  }
  const channels =
    busy.asteriskChannels === null
      ? 'unknown, ARI did not answer'
      : String(busy.asteriskChannels);
  return `live calls ${String(busy.liveCalls)}, Asterisk channels ${channels}, recordings in progress ${String(busy.recordingsInProgress)}`;
}

/** The gate's give-up as it reports it: the moments given up in a row, and what was busy. */
export type GiveUp = { inARow: number; reason: string };

/**
 * Records that the gate gave up on `work`, `IDLE_WAIT_MS` past the maintenance moment `moment`,
 * with what its last look found busy: one more in a row in `maintenance_gate`, a warning and an
 * audit entry.
 */
export async function recordGiveUp(
  db: Db,
  entry: { work: MaintenanceWork; moment: Date; busy: Busy; at: Date }
): Promise<GiveUp> {
  const reason = describeBusy(entry.busy);
  const row = await db
    .insertInto('maintenanceGate')
    .values({
      work: entry.work,
      gaveUpAt: entry.at.toISOString(),
      reason,
      consecutiveGiveUps: 1
    })
    .onConflict(oc =>
      oc.column('work').doUpdateSet(eb => ({
        gaveUpAt: eb.ref('excluded.gaveUpAt'),
        reason: eb.ref('excluded.reason'),
        consecutiveGiveUps: eb('maintenanceGate.consecutiveGiveUps', '+', 1)
      }))
    )
    .returning('consecutiveGiveUps')
    .executeTakeFirstOrThrow();
  const inARow = row.consecutiveGiveUps;
  const moment = entry.moment.toISOString();
  logger.warn(
    { work: entry.work, moment, reason, inARow },
    `maintenance gate: gave up on ${WORK_LABELS[entry.work]} at the maintenance moment ${moment}, the system stayed busy (${reason}); it waits for the next moment`
  );
  await recordOutcome(db, {
    caller: JOB_CALLER,
    operation: 'system.maintenanceGate',
    entity: { kind: 'system', id: null },
    changes: outcomeChanges({
      work: entry.work,
      outcome: 'gaveUp',
      moment,
      reason,
      inARow,
      ...('coreError' in entry.busy ? {} : entry.busy)
    })
  });
  return { inARow, reason };
}

/** Ends `work`'s run of give-ups: it went through, or is no longer pending. */
export async function clearGiveUpsInARow(
  db: Db,
  work: MaintenanceWork
): Promise<void> {
  await db
    .updateTable('maintenanceGate')
    .set({ consecutiveGiveUps: 0 })
    .where('work', '=', work)
    .where('consecutiveGiveUps', '>', 0)
    .execute();
}

/** When the gate last gave up on a work and why, as `system.info` shows it. */
export type LastGiveUp = { at: string; reason: string };

/** The last give-up per work, `null` for a work the gate never gave up on. */
export async function lastGiveUps(
  db: Db
): Promise<Record<MaintenanceWork, LastGiveUp | null>> {
  const rows = await db.selectFrom('maintenanceGate').selectAll().execute();
  const of = (work: MaintenanceWork): LastGiveUp | null => {
    const row = rows.find(candidate => candidate.work === work);
    return row === undefined ? null : { at: row.gaveUpAt, reason: row.reason };
  };
  return { certSync: of('certSync'), autoUpdate: of('autoUpdate') };
}
