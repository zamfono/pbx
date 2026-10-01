/**
 * The maintenance gate (§6.4 "Maintenance gate"): the one check `api` passes before it touches
 * the running system on its own, a scheduled certificate swap (`certSync.ts`) and an automatic
 * update (`autoUpdate.ts`) alike. It opens at the next maintenance moment `nextMaintenanceMoment`
 * resolves, once `core` reports nothing in progress; while something is, it looks again every
 * `IDLE_RECHECK_MS`, and `IDLE_WAIT_MS` after the moment it gives up until the moment after.
 */
import { MINUTES_PER_HOUR, type Db, type StateResponse } from '@zamfono/shared';

import type { CoreClient } from '../coreClient.js';
import { nextMaintenanceMoment } from './reloadTiming.js';

const MS_PER_MINUTE = 60_000;
const IDLE_WAIT_HOURS = 2;
const IDLE_RECHECK_MINUTES = 5;

/** How long past its maintenance moment the gate waits for an idle system. */
export const IDLE_WAIT_MS = IDLE_WAIT_HOURS * MINUTES_PER_HOUR * MS_PER_MINUTE;
/** How often the gate looks again while the system is busy within that wait. */
export const IDLE_RECHECK_MS = IDLE_RECHECK_MINUTES * MS_PER_MINUTE;

/**
 * Whether `core`'s live state shows the system idle: no call, no channel Asterisk holds (a parked
 * party, a voicemail deposit and a menu each hold one), no recording being made or mixed. A state
 * without `asteriskChannels`, from a `core` that does not report it, or with `null` for it, while
 * ARI does not answer, is never idle.
 */
export function isIdleState(state: StateResponse): boolean {
  return (
    state.calls.length === 0 &&
    state.asteriskChannels === 0 &&
    state.recordingsInProgress === 0
  );
}

/** `isIdleState` of `core`'s live state; a `core` that does not answer is not idle. */
export async function coreIsIdle(
  core: Pick<CoreClient, 'state'>
): Promise<boolean> {
  try {
    return isIdleState(await core.state());
  } catch {
    return false;
  }
}

/** `open` when the system may be touched now; otherwise when the gate is worth asking again. */
export type GateCheck = { open: true } | { open: false; nextCheckAt: Date };

export type MaintenanceGate = {
  check: (now: Date) => Promise<GateCheck>;
  /** Forgets the moment held, so the next check resolves a fresh one. */
  reset: () => void;
};

export type MaintenanceGateDeps = {
  db: Db;
  isIdle: () => Promise<boolean>;
};

/**
 * A gate for one piece of pending work. The moment, once resolved, is held across checks rather
 * than resolved afresh each time: resolved against a later `now`, "the next 03:00" just after
 * 03:00 is tomorrow's, so the work would never come due. An open check forgets it, as does a
 * wait that ran out, which resolves the next moment from then on.
 */
export function createMaintenanceGate(
  deps: MaintenanceGateDeps
): MaintenanceGate {
  const held: { momentMs: number | null } = { momentMs: null };
  return {
    async check(now) {
      const nowMs = now.getTime();
      const heldMs = held.momentMs;
      const momentMs =
        heldMs === null || nowMs >= heldMs + IDLE_WAIT_MS
          ? (await nextMaintenanceMoment(deps.db, now)).getTime()
          : heldMs;
      // eslint-disable-next-line require-atomic-updates -- a gate serves one piece of work, whose owner runs one check at a time
      held.momentMs = momentMs;
      if (nowMs < momentMs) {
        return { open: false, nextCheckAt: new Date(momentMs) };
      }
      if (await deps.isIdle()) {
        // eslint-disable-next-line require-atomic-updates -- see above
        held.momentMs = null;
        return { open: true };
      }
      const giveUpMs = momentMs + IDLE_WAIT_MS;
      return {
        open: false,
        nextCheckAt: new Date(Math.min(nowMs + IDLE_RECHECK_MS, giveUpMs))
      };
    },
    reset() {
      held.momentMs = null;
    }
  };
}
