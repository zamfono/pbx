/**
 * Out-of-office and opening-hours evaluation (spec §10.1 steps 2-3, §10.2 "Out
 * of office" / "Opening hours"). Pure functions only: the routing pipeline
 * passes in the rows already loaded for a call, and every calendar
 * computation goes through `Temporal` rather than a date library.
 */

import {
  closedPeriods,
  MS_PER_DAY,
  type OpeningInterval,
  type Scope
} from '@zamfono/shared';

// A weekly schedule repeats every 7 days; one day more always reaches the next edge of one that
// has any, even from just after the last edge of the week.
const EDGE_SCAN_DAYS = 8;

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
  intervals: OpeningInterval[];
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

/** Whether `schedule` is open at `nowIso`, evaluated in `timezone` (§10.2 "Opening hours"): closed
 * exactly when a closed period of `closedPeriods`, whose edges follow the DST rule, starts now. */
export function isOpen(
  schedule: Schedule,
  nowIso: string,
  timezone: string
): boolean {
  const [first] = closedPeriods(schedule, nowIso, 1, timezone);
  return first === undefined || Date.parse(first.start) > Date.parse(nowIso);
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
 * The first instant after `nowIso` at which `inEffectOoo` or `isOpen` can change for any scope:
 * the next `startsAt`/`expiresAt` of an active OOO rule, or the next open/close edge of an active
 * schedule in `timezone`; `null` when none lies within the coming week. A later config change
 * brings its own re-evaluation, so rules that are inactive now need no edge.
 */
export function nextTransition(
  rules: OooRule[],
  schedules: Schedule[],
  nowIso: string,
  timezone: string
): number | null {
  const now = Date.parse(nowIso);
  const edges: number[] = [];
  for (const rule of rules) {
    if (!rule.active) {
      continue;
    }
    for (const bound of [rule.startsAt, rule.expiresAt]) {
      if (bound !== null) {
        edges.push(Date.parse(bound));
      }
    }
  }
  const windowEnd = now + EDGE_SCAN_DAYS * MS_PER_DAY;
  for (const schedule of schedules) {
    if (!schedule.active) {
      continue;
    }
    for (const period of closedPeriods(
      schedule,
      nowIso,
      EDGE_SCAN_DAYS,
      timezone
    )) {
      // The scan window's own ends (`now`, a week and a day on) are no edges of the schedule.
      for (const bound of [period.start, period.end]) {
        const edge = Date.parse(bound);
        if (edge < windowEnd) {
          edges.push(edge);
        }
      }
    }
  }
  const future = edges.filter(edge => edge > now);
  return future.length === 0 ? null : Math.min(...future);
}
