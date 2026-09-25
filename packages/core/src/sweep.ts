/**
 * Minute sweep for out-of-office and opening-hours transitions (§3.1 "Events": core's minute
 * sweep for OOO and opening hours writes nothing, it evaluates and emits; §10.2 "Out of office",
 * "Opening hours"; §10.6 `ooo`/`hours`). Every scope in the config snapshot - the tenant, every
 * user, ring group and menu - gets its own in-effect OOO rule and open state; only a change from
 * the previous tick goes on the bus, so a client renders live status without polling.
 */
import { resolveTenantTimeZone, type Scope } from '@zamfono/shared';

import type { ConfigCache, EventBus } from './internal/server.js';
import type { Snapshot } from './internal/snapshot.js';
import {
  inEffectOoo,
  isOpen,
  scheduleFor,
  type OooRule,
  type Schedule
} from './routing/schedule.js';

/** `startSweep`'s dependencies: the config snapshot, the bus it emits transitions onto, the clock
 * and the stack's zone. */
export type SweepDeps = {
  cache: ConfigCache;
  bus: EventBus;
  now: () => string;
  // The stack's `TZ` (§11.4 `timezone`: "NULL = stack `TZ`, else UTC"), `CoreEnv.tz`.
  stackTz?: string;
};

const DEFAULT_INTERVAL_MS = 60_000;

type ScopeState = {
  oooActive: boolean;
  oooStartsAt: string | null;
  oooExpiresAt: string | null;
  hoursOpen: boolean | null;
};

/** The scope a row's `scopeUserId`/`scopeRingGroupId`/`scopeMenuId` exclusive arc encodes. */
function scopeOf(row: {
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

/** The snapshot's `oooRules` rows, live ones only, as the routing pipeline's `OooRule[]`. */
function oooRulesFrom(snapshot: Snapshot): OooRule[] {
  return snapshot.oooRules
    .filter(row => row.deletedAt === null)
    .map(row => ({
      id: row.id,
      scope: scopeOf(row),
      active: row.active === 1,
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
      targetId: row.targetId
    }));
}

/** The snapshot's `openingHours`/`openingHoursIntervals` rows as the routing pipeline's `Schedule[]`. */
function schedulesFrom(snapshot: Snapshot): Schedule[] {
  const intervalsById = new Map<string, Schedule['intervals']>();
  for (const interval of snapshot.openingHoursIntervals) {
    const intervals = intervalsById.get(interval.openingHoursId) ?? [];
    intervals.push({
      weekday: interval.weekday as Schedule['intervals'][number]['weekday'],
      opens: interval.opens,
      closes: interval.closes
    });
    intervalsById.set(interval.openingHoursId, intervals);
  }
  return snapshot.openingHours
    .filter(row => row.deletedAt === null)
    .map(row => ({
      id: row.id,
      scope: scopeOf(row),
      active: row.active === 1,
      closedTargetId: row.closedTargetId,
      intervals: intervalsById.get(row.id) ?? []
    }));
}

/** The tenant scope plus every live user, ring group and menu scope (§10.6 `Scope`). */
function allScopes(snapshot: Snapshot): Scope[] {
  const scopes: Scope[] = ['tenant'];
  for (const user of snapshot.users) {
    if (user.deletedAt === null) {
      scopes.push(`user:${user.id}`);
    }
  }
  for (const ringGroup of snapshot.ringGroups) {
    if (ringGroup.deletedAt === null) {
      scopes.push(`ringGroup:${ringGroup.id}`);
    }
  }
  for (const menu of snapshot.menus) {
    if (menu.deletedAt === null) {
      scopes.push(`menu:${menu.id}`);
    }
  }
  return scopes;
}

/** `scope`'s in-effect OOO rule and open state at `nowIso`, both resolved through the tenant fallback. */
function evaluateScope(
  scope: Scope,
  oooRules: OooRule[],
  schedules: Schedule[],
  nowIso: string,
  timezone: string
): ScopeState {
  const inEffect = inEffectOoo(oooRules, scope, nowIso);
  const schedule = scheduleFor(schedules, scope);
  return {
    oooActive: inEffect !== null,
    oooStartsAt: inEffect?.startsAt ?? null,
    oooExpiresAt: inEffect?.expiresAt ?? null,
    hoursOpen: schedule === null ? null : isOpen(schedule, nowIso, timezone)
  };
}

/**
 * Evaluates every scope in `snapshot` and emits an `ooo` or `hours` event for a scope that has no
 * recorded state yet (the initial sweep) or whose active/open state changed since `previous`.
 */
function tick(
  deps: SweepDeps,
  snapshot: Snapshot,
  previous: Map<Scope, ScopeState>
): void {
  const oooRules = oooRulesFrom(snapshot);
  const schedules = schedulesFrom(snapshot);
  const nowIso = deps.now();
  const timezone = resolveTenantTimeZone(
    snapshot.settings.timezone,
    deps.stackTz
  );
  for (const scope of allScopes(snapshot)) {
    const state = evaluateScope(scope, oooRules, schedules, nowIso, timezone);
    const prior = previous.get(scope);
    if (prior?.oooActive !== state.oooActive) {
      deps.bus.emit({
        type: 'ooo',
        scope,
        active: state.oooActive,
        startsAt: state.oooStartsAt,
        expiresAt: state.oooExpiresAt
      });
    }
    if (state.hoursOpen !== null && prior?.hoursOpen !== state.hoursOpen) {
      deps.bus.emit({ type: 'hours', scope, open: state.hoursOpen });
    }
    previous.set(scope, state);
  }
}

/**
 * Runs `tick` immediately, then every `intervalMs` (one minute by default), against `deps.cache`'s
 * current snapshot. `stop()` cancels the interval; a tick that fails to load the snapshot is
 * skipped and retried on the next one.
 */
export function startSweep(
  deps: SweepDeps,
  intervalMs: number = DEFAULT_INTERVAL_MS
): { stop: () => void } {
  const previous = new Map<Scope, ScopeState>();
  const run = (): void => {
    deps.cache
      .get()
      .then(snapshot => {
        tick(deps, snapshot, previous);
      })
      // ponytail: no logger is wired into this module; add one if a failed sweep needs investigating.
      .catch(() => undefined);
  };
  run();
  const timer = setInterval(run, intervalMs);
  return {
    stop(): void {
      clearInterval(timer);
    }
  };
}
