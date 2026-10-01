/**
 * The maintenance gate (§6.4 "Maintenance gate"): the one check `api` passes before it touches
 * the running system on its own, a scheduled certificate swap (`certSync.ts`) and an automatic
 * update (`autoUpdate.ts`) alike. It opens at the next maintenance moment `nextMaintenanceMoment`
 * resolves, once `core` reports nothing in progress; while something is, it looks again every
 * `IDLE_RECHECK_MS`, and `IDLE_WAIT_MS` after the moment it gives up until the moment after,
 * reporting what kept the system busy (`maintenanceGiveUp.ts`).
 */
import { MINUTES_PER_HOUR, type Db } from '@zamfono/shared';

import {
  clearGiveUpsInARow,
  recordGiveUp,
  type Busy,
  type GiveUp,
  type MaintenanceWork
} from './maintenanceGiveUp.js';
import { nextMaintenanceMoment } from './reloadTiming.js';

const MS_PER_MINUTE = 60_000;
const IDLE_WAIT_HOURS = 2;
const IDLE_RECHECK_MINUTES = 5;

/** How long past its maintenance moment the gate waits for an idle system. */
export const IDLE_WAIT_MS = IDLE_WAIT_HOURS * MINUTES_PER_HOUR * MS_PER_MINUTE;
/** How often the gate looks again while the system is busy within that wait. */
export const IDLE_RECHECK_MS = IDLE_RECHECK_MINUTES * MS_PER_MINUTE;

/**
 * `open` when the system may be touched now; otherwise when the gate is worth asking again, and
 * `gaveUp` on the check at which it gave up on a moment.
 */
export type GateCheck =
  { open: true } | { open: false; nextCheckAt: Date; gaveUp?: GiveUp };

export type MaintenanceGate = {
  check: (now: Date) => Promise<GateCheck>;
  /** Forgets the moment held, so the next check resolves a fresh one, and ends a run of give-ups. */
  reset: () => Promise<void>;
};

export type MaintenanceGateDeps = {
  db: Db;
  work: MaintenanceWork;
  /** What is in progress now, `null` while the system is idle (`coreBusy`). */
  busy: () => Promise<Busy | null>;
};

/**
 * A gate for one piece of pending work. The moment, once resolved, is held across checks rather
 * than resolved afresh each time: resolved against a later `now`, "the next 03:00" just after
 * 03:00 is tomorrow's, so the work would never come due. An open check forgets it, as does a
 * wait that ran out, which resolves the next moment from then on and, when a look within the
 * wait found the system busy, records the give-up with what that last look found.
 */
export function createMaintenanceGate(
  deps: MaintenanceGateDeps
): MaintenanceGate {
  const held: { momentMs: number | null; lastBusy: Busy | null } = {
    momentMs: null,
    lastBusy: null
  };

  /** The give-up `now` ends the held moment's wait with, when a look found the system busy. */
  async function giveUpIfDue(now: Date): Promise<GiveUp | undefined> {
    const { momentMs, lastBusy } = held;
    if (momentMs === null || now.getTime() < momentMs + IDLE_WAIT_MS) {
      return undefined;
    }
    held.momentMs = null;
    held.lastBusy = null;
    if (lastBusy === null) {
      return undefined;
    }
    return recordGiveUp(deps.db, {
      work: deps.work,
      moment: new Date(momentMs),
      busy: lastBusy,
      at: now
    });
  }

  return {
    async check(now) {
      const nowMs = now.getTime();
      const gaveUp = await giveUpIfDue(now);
      const momentMs =
        held.momentMs ?? (await nextMaintenanceMoment(deps.db, now)).getTime();
      // eslint-disable-next-line require-atomic-updates -- a gate serves one piece of work, whose owner runs one check at a time
      held.momentMs = momentMs;
      const shut = gaveUp === undefined ? {} : { gaveUp };
      if (nowMs < momentMs) {
        return { open: false, nextCheckAt: new Date(momentMs), ...shut };
      }
      const busy = await deps.busy();
      if (busy === null) {
        // eslint-disable-next-line require-atomic-updates -- see above
        held.momentMs = null;
        // eslint-disable-next-line require-atomic-updates -- see above
        held.lastBusy = null;
        await clearGiveUpsInARow(deps.db, deps.work);
        return { open: true };
      }
      // eslint-disable-next-line require-atomic-updates -- see above
      held.lastBusy = busy;
      const giveUpMs = momentMs + IDLE_WAIT_MS;
      return {
        open: false,
        nextCheckAt: new Date(Math.min(nowMs + IDLE_RECHECK_MS, giveUpMs)),
        ...shut
      };
    },
    async reset() {
      held.momentMs = null;
      held.lastBusy = null;
      await clearGiveUpsInARow(deps.db, deps.work);
    }
  };
}
