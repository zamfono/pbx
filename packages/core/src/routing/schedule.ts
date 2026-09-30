/**
 * Out-of-office and opening-hours evaluation (spec §10.1 steps 2-3, §10.2 "Out
 * of office" / "Opening hours"). Pure functions only: the routing pipeline
 * passes in the rows already loaded for a call, and every calendar
 * computation goes through `Intl` rather than a date library.
 */

import {
  localParts,
  MINUTES_PER_HOUR,
  parseTimeOfDay,
  type Scope,
  type Weekday
} from '@zamfono/shared';

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
