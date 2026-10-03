/**
 * The config snapshot's `ooo_rules` and `opening_hours`/`opening_hours_intervals` rows as the
 * `OooRule[]`/`Schedule[]` `schedule.ts` evaluates, shared by the routing pipeline's steps 2-3
 * (§10.1) and the OOO/hours sweep (§3.1 "Events"), so both read the rows the same way.
 */
import type { Scope } from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';
import type { OooRule, Schedule } from './schedule.js';

/** The `Scope` a row's `scopeUserId`/`scopeRingGroupId`/`scopeMenuId` exclusive arc encodes. */
function scopeFromRow(row: {
  scopeUserId: string | null;
  scopeRingGroupId: string | null;
  scopeMenuId: string | null;
}): Scope {
  if (row.scopeUserId !== null) {
    return `user:${row.scopeUserId}`;
  }
  if (row.scopeRingGroupId !== null) {
    return `ringGroup:${row.scopeRingGroupId}`;
  }
  if (row.scopeMenuId !== null) {
    return `menu:${row.scopeMenuId}`;
  }
  return 'tenant';
}

/** `ooo_rules` rows as the `OooRule[]` `inEffectOoo` (§10.1 step 2) expects. */
export function buildOooRules(rows: Snapshot['oooRules']): OooRule[] {
  return rows.map(row => ({
    id: row.id,
    scope: scopeFromRow(row),
    active: row.active === 1,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    targetId: row.targetId
  }));
}

/** `opening_hours`/`opening_hours_intervals` rows as the `Schedule[]` `scheduleFor` (§10.1 step 3) expects. */
export function buildSchedules(
  rows: Snapshot['openingHours'],
  intervalRows: Snapshot['openingHoursIntervals']
): Schedule[] {
  return rows.map(row => ({
    id: row.id,
    scope: scopeFromRow(row),
    active: row.active === 1,
    closedTargetId: row.closedTargetId,
    intervals: intervalRows
      .filter(interval => interval.openingHoursId === row.id)
      .map(interval => ({
        weekday: interval.weekday,
        opens: interval.opens,
        closes: interval.closes
      }))
  }));
}
