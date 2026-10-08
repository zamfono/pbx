/**
 * How a scope's calls are handled right now, as `core` evaluates it (§10.2 "Out of office",
 * "Opening hours"; `core/src/routing/schedule.ts`): an out-of-office rule in effect comes first,
 * the scope's own or else the tenant's; then the scope's own active opening hours, else the
 * tenant's active ones; a scope without any schedule is always open. Opening hours are evaluated
 * in the tenant time zone (`settings.timezone`, the stack's zone when unset).
 */
import type {
  Db,
  HoursInterval,
  OooRule,
  OpeningHours,
  ScheduleScope,
  ScopeKey
} from '#lib/api/types.js';
import { now as demoNow } from '#lib/clock.svelte.js';

const DEFAULT_TIME_ZONE = 'Europe/Berlin';
const MINUTES_PER_HOUR = 60;
const DAYS_PER_WEEK = 7;
const END_OF_DAY = 24 * MINUTES_PER_HOUR;

export const scopeKey = (scope: ScheduleScope): ScopeKey =>
  scope.kind === 'tenant' ? 'tenant' : `${scope.kind}:${scope.id}`;

export const sameScope = (
  first: ScheduleScope,
  second: ScheduleScope
): boolean => scopeKey(first) === scopeKey(second);

export const TENANT: ScheduleScope = { kind: 'tenant' };

export const tenantTimeZone = (db: Db): string =>
  db.settings.timezone ?? DEFAULT_TIME_ZONE;

const instant = (iso: string | null): number | null =>
  iso === null ? null : Date.parse(iso);

/** Whether `rule` is in effect at `now`: live, active, started and not yet expired. */
export function ruleInEffect(rule: OooRule, now: number): boolean {
  const starts = instant(rule.startsAt);
  const expires = instant(rule.expiresAt);
  return (
    rule.deletedAt === null &&
    rule.active &&
    (starts === null || starts <= now) &&
    (expires === null || expires > now)
  );
}

/** The scope's own out-of-office rule in effect at `now`, or null. */
export function ownRuleInEffect(
  db: Db,
  scope: ScheduleScope,
  now: number
): OooRule | null {
  return (
    db.oooRules.find(
      rule => sameScope(rule.scope, scope) && ruleInEffect(rule, now)
    ) ?? null
  );
}

/** The live opening-hours schedule set for exactly `scope`, active or not. */
export function ownSchedule(db: Db, scope: ScheduleScope): OpeningHours | null {
  return (
    db.openingHours.find(
      hours => hours.deletedAt === null && sameScope(hours.scope, scope)
    ) ?? null
  );
}

type LocalTime = { weekday: number; minutes: number };

/** Weekday (1 = Monday) and minutes since midnight of `now` in `timeZone`. */
export function localTime(now: number, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(now));
  const part = (type: string): string =>
    parts.find(entry => entry.type === type)?.value ?? '';
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    weekday: weekdays.indexOf(part('weekday')) + 1,
    minutes: Number(part('hour')) * MINUTES_PER_HOUR + Number(part('minute'))
  };
}

const toMinutes = (time: string): number => {
  if (time === '24:00') {
    return END_OF_DAY;
  }
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * MINUTES_PER_HOUR + Number(minutes);
};

/** Whether `intervals` are open at local time `at`. */
export function openAt(intervals: HoursInterval[], at: LocalTime): boolean {
  return intervals.some(
    interval =>
      interval.weekday === at.weekday &&
      toMinutes(interval.opens) <= at.minutes &&
      at.minutes < toMinutes(interval.closes)
  );
}

/**
 * When the open state of `intervals` next changes after local time `at`, within a week: the
 * weekday and `HH:MM`; touching intervals count as one opening period. Null when it never changes.
 */
export function nextChange(
  intervals: HoursInterval[],
  at: LocalTime
): { weekday: number; time: string } | null {
  const open = openAt(intervals, at);
  for (let step = 1; step <= DAYS_PER_WEEK * END_OF_DAY; step += 1) {
    const total = at.minutes + step;
    const minutes = total % END_OF_DAY;
    const weekday =
      ((at.weekday - 1 + Math.floor(total / END_OF_DAY)) % DAYS_PER_WEEK) + 1;
    if (openAt(intervals, { weekday, minutes }) !== open) {
      const hours = String(Math.floor(minutes / MINUTES_PER_HOUR)).padStart(
        2,
        '0'
      );
      return {
        weekday,
        time: `${hours}:${String(minutes % MINUTES_PER_HOUR).padStart(2, '0')}`
      };
    }
  }
  return null;
}

export type ScopeStatus = {
  /** The out-of-office rule in effect, the scope's own or else the tenant's. */
  ooo: OooRule | null;
  oooInherited: boolean;
  /** The schedule that applies: the scope's own active one, else the tenant's active one. */
  hours: OpeningHours | null;
  hoursInherited: boolean;
  /** Open under `hours`; null when no schedule applies (always open). */
  open: boolean | null;
  next: { weekday: number; time: string } | null;
};

export function scopeStatus(
  db: Db,
  scope: ScheduleScope,
  now = demoNow()
): ScopeStatus {
  const ownRule = ownRuleInEffect(db, scope, now);
  const tenantRule =
    scope.kind === 'tenant' ? null : ownRuleInEffect(db, TENANT, now);
  const own = ownSchedule(db, scope);
  const tenant = scope.kind === 'tenant' ? null : ownSchedule(db, TENANT);
  const hours =
    own?.active === true ? own : tenant?.active === true ? tenant : null;
  const at = localTime(now, tenantTimeZone(db));
  return {
    ooo: ownRule ?? tenantRule,
    oooInherited: ownRule === null && tenantRule !== null,
    hours,
    hoursInherited: hours !== null && hours !== own,
    open: hours === null ? null : openAt(hours.intervals, at),
    next: hours === null ? null : nextChange(hours.intervals, at)
  };
}

type ScopeState = {
  oooActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  open: boolean | null;
};

/** Every scope's state as `core`'s sweep records it: the tenant and each live user, ring group and menu. */
export function scheduleStates(
  db: Db,
  now = demoNow()
): Map<ScopeKey, ScopeState> {
  const scopes: ScheduleScope[] = [
    TENANT,
    ...db.users
      .filter(row => row.deletedAt === null)
      .map(row => ({ kind: 'user' as const, id: row.id })),
    ...db.ringGroups
      .filter(row => row.deletedAt === null)
      .map(row => ({ kind: 'ringGroup' as const, id: row.id })),
    ...db.menus
      .filter(row => row.deletedAt === null)
      .map(row => ({ kind: 'menu' as const, id: row.id }))
  ];
  const states = new Map<ScopeKey, ScopeState>();
  for (const scope of scopes) {
    const status = scopeStatus(db, scope, now);
    states.set(scopeKey(scope), {
      oooActive: status.ooo !== null,
      startsAt: status.ooo?.startsAt ?? null,
      expiresAt: status.ooo?.expiresAt ?? null,
      open: status.open
    });
  }
  return states;
}

/** The `ooo` and `hours` events `core`'s sweep emits after a configuration change: one per scope
 * whose state differs from `before`. */
export function transitions(
  before: Map<ScopeKey, ScopeState>,
  after: Map<ScopeKey, ScopeState>
): (
  | {
      type: 'ooo';
      scope: ScopeKey;
      active: boolean;
      startsAt: string | null;
      expiresAt: string | null;
    }
  | { type: 'hours'; scope: ScopeKey; open: boolean }
)[] {
  const events: ReturnType<typeof transitions> = [];
  for (const [scope, state] of after) {
    const prior = before.get(scope);
    if (prior === undefined) {
      continue;
    }
    if (
      prior.oooActive !== state.oooActive ||
      prior.startsAt !== state.startsAt ||
      prior.expiresAt !== state.expiresAt
    ) {
      events.push({
        type: 'ooo',
        scope,
        active: state.oooActive,
        startsAt: state.startsAt,
        expiresAt: state.expiresAt
      });
    }
    if (state.open !== null && prior.open !== state.open) {
      events.push({ type: 'hours', scope, open: state.open });
    }
  }
  return events;
}
