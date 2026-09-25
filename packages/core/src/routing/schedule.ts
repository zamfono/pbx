/**
 * Out-of-office and opening-hours evaluation (spec §10.1 steps 2-3, §10.2 "Out
 * of office" / "Opening hours"). Pure functions only: the routing pipeline
 * passes in the rows already loaded for a call, and every calendar
 * computation goes through `Intl` rather than a date library.
 */

import type { Scope } from '@zamfono/shared';

import {
  addDays,
  localParts,
  MINUTES_PER_HOUR,
  parseTimeOfDay,
  weekdayAt,
  zonedTimeToInstant,
  type Weekday
} from './zonedTime.js';

export type OooRule = {
  id: string;
  scope: Scope;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  targetId: string;
};

export type Schedule = {
  id: string;
  scope: Scope;
  active: boolean;
  closedTargetId: string;
  intervals: { weekday: Weekday; opens: string; closes: string }[];
};

const HOURS_PER_DAY = 24;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MILLISECONDS_PER_SECOND;

/**
 * The in-effect OOO rule of `scope` itself: an active rule of that scope whose
 * `[startsAt, expiresAt)` window (either bound may be open-ended) contains
 * `nowIso`, else null. A ring-group member is skipped only under their own
 * rule (§10.1 step 5); the tenant rule belongs to the call's scope step.
 */
export function ownInEffectOoo(
  rules: OooRule[],
  scope: Scope,
  nowIso: string
): OooRule | null {
  const now = Date.parse(nowIso);
  return (
    rules.find(
      rule =>
        rule.scope === scope &&
        rule.active &&
        (rule.startsAt === null || Date.parse(rule.startsAt) <= now) &&
        (rule.expiresAt === null || now < Date.parse(rule.expiresAt))
    ) ?? null
  );
}

/**
 * The in-effect OOO rule for `scope` (§10.1 step 2): its own in-effect rule,
 * else the tenant's own in-effect rule, else null.
 */
export function inEffectOoo(
  rules: OooRule[],
  scope: Scope,
  nowIso: string
): OooRule | null {
  return (
    ownInEffectOoo(rules, scope, nowIso) ??
    (scope === 'tenant' ? null : ownInEffectOoo(rules, 'tenant', nowIso))
  );
}

/** Whether `schedule` is open at `nowIso`, evaluated in `timezone` (§10.2 "Opening hours"). */
export function isOpen(
  schedule: Schedule,
  nowIso: string,
  timezone: string
): boolean {
  const local = localParts(new Date(nowIso).getTime(), timezone);
  const minuteOfDay = local.hour * MINUTES_PER_HOUR + local.minute;
  return schedule.intervals.some(
    interval =>
      interval.weekday === local.weekday &&
      minuteOfDay >= parseTimeOfDay(interval.opens) &&
      minuteOfDay < parseTimeOfDay(interval.closes)
  );
}

/** The active schedule for `scope`, else the tenant's active schedule, else null. */
export function scheduleFor(
  schedules: Schedule[],
  scope: Scope
): Schedule | null {
  const own = schedules.find(
    schedule => schedule.scope === scope && schedule.active
  );
  if (own) {
    return own;
  }
  if (scope === 'tenant') {
    return null;
  }
  return (
    schedules.find(
      schedule => schedule.scope === 'tenant' && schedule.active
    ) ?? null
  );
}

/**
 * The closed periods of `schedule` within `[fromIso, fromIso + days)`, merged
 * across day boundaries, for §6.4 step 2's midpoint-of-longest-closed-period
 * search.
 */
export function closedPeriods(
  schedule: Schedule,
  fromIso: string,
  days: number,
  timezone: string
): { start: string; end: string }[] {
  const from = new Date(fromIso).getTime();
  const to = from + days * MILLISECONDS_PER_DAY;
  const start = localParts(from, timezone);

  const openIntervals: { start: number; end: number }[] = [];
  // One extra day on each side of the range so an open interval that starts before `from` or
  // ends after `to` is still found and clipped into range, instead of being missed entirely.
  for (let dayOffset = -1; dayOffset <= days; dayOffset += 1) {
    const weekday = weekdayAt(start.weekday, dayOffset);
    const dayDate = addDays(start, dayOffset);
    for (const interval of schedule.intervals) {
      if (interval.weekday !== weekday) {
        continue;
      }
      const openStart = zonedTimeToInstant(
        dayDate.year,
        dayDate.month,
        dayDate.day,
        parseTimeOfDay(interval.opens),
        timezone
      );
      const openEnd = zonedTimeToInstant(
        dayDate.year,
        dayDate.month,
        dayDate.day,
        parseTimeOfDay(interval.closes),
        timezone
      );
      if (openEnd <= from || openStart >= to) {
        continue;
      }
      openIntervals.push({
        start: Math.max(openStart, from),
        end: Math.min(openEnd, to)
      });
    }
  }
  openIntervals.sort((earlier, later) => earlier.start - later.start);

  const mergedOpen: { start: number; end: number }[] = [];
  for (const interval of openIntervals) {
    const last = mergedOpen.at(-1);
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      mergedOpen.push({ ...interval });
    }
  }

  const closed: { start: string; end: string }[] = [];
  let cursor = from;
  for (const interval of mergedOpen) {
    if (interval.start > cursor) {
      closed.push({
        start: new Date(cursor).toISOString(),
        end: new Date(interval.start).toISOString()
      });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < to) {
    closed.push({
      start: new Date(cursor).toISOString(),
      end: new Date(to).toISOString()
    });
  }
  return closed;
}
