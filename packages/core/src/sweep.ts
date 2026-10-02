/**
 * The sweep for out-of-office and opening-hours transitions (§3.1 "Events": core's sweep for OOO
 * and opening hours writes nothing, it evaluates and emits; §10.2 "Out of office", "Opening
 * hours"; §10.6 `ooo`/`hours`). Every scope in the config snapshot - the tenant, every user, ring
 * group and menu - gets its own in-effect OOO rule and open state; only a change from the previous
 * evaluation goes on the bus (a rule starting or ending, the window of the rule in effect moving,
 * opening hours opening or closing), so a client renders live status without polling. It runs at the
 * next transition instant of any scope, at once after a config change, and at least hourly.
 */
import { resolveTenantTimeZone, type Scope } from '@zamfono/shared';

import type { Logger } from './ari/types.js';
import type { EventBus } from './internal/eventBus.js';
import type { ConfigCache, Snapshot } from './internal/snapshot.js';
import {
  inEffectOoo,
  isOpen,
  nextTransition,
  scheduleFor,
  type OooRule,
  type Schedule
} from './routing/schedule.js';
import { buildOooRules, buildSchedules } from './routing/scheduleRows.js';

/** `startSweep`'s dependencies: the config snapshot, the bus it emits transitions onto, the clock
 * and the stack's zone. */
export type SweepDeps = {
  cache: ConfigCache;
  bus: EventBus;
  log: Logger;
  now: () => string;
  // The stack's `TZ` (§11.4 `timezone`: "NULL = stack `TZ`, else UTC"), `CoreEnv.tz`.
  stackTz: string;
};

// The backstop: a wall-clock jump (NTP step, suspended VM) or a zone's rule change moves the
// transition instants a timer armed earlier waits for, so no timer waits longer than this.
const DEFAULT_BACKSTOP_MS = 3_600_000;
// A sweep that failed to load the snapshot retries after this, rather than waiting an hour.
const RETRY_MS = 60_000;

type ScopeState = {
  oooActive: boolean;
  oooStartsAt: string | null;
  oooExpiresAt: string | null;
  hoursOpen: boolean | null;
};

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

/** Whether `state`'s OOO differs from `prior`'s as an `ooo` event carries it: active or not, and
 * the in-effect rule's `startsAt`/`expiresAt`. */
function oooChanged(prior: ScopeState | undefined, state: ScopeState): boolean {
  return (
    prior?.oooActive !== state.oooActive ||
    prior.oooStartsAt !== state.oooStartsAt ||
    prior.oooExpiresAt !== state.oooExpiresAt
  );
}

/**
 * Evaluates every scope in `snapshot` and emits an `ooo` or `hours` event for a scope that has no
 * recorded state yet (the initial sweep) or whose active/open state changed since `previous`, and
 * an `ooo` event as well for one whose rule in effect has another window: the rule edited while it
 * runs, or handed over to the next back to back.
 * Returns the next instant any scope can change at (`nextTransition`), `null` for none this week.
 */
function tick(
  deps: SweepDeps,
  snapshot: Snapshot,
  previous: Map<Scope, ScopeState>
): number | null {
  const oooRules = buildOooRules(snapshot.oooRules);
  const schedules = buildSchedules(
    snapshot.openingHours,
    snapshot.openingHoursIntervals
  );
  const nowIso = deps.now();
  const timezone = resolveTenantTimeZone(
    snapshot.settings.timezone,
    deps.stackTz
  );
  for (const scope of allScopes(snapshot)) {
    const state = evaluateScope(scope, oooRules, schedules, nowIso, timezone);
    const prior = previous.get(scope);
    if (oooChanged(prior, state)) {
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
  return nextTransition(oooRules, schedules, nowIso, timezone);
}

/** One started sweep: the recorded scope states, the armed timer and the latest run's number. */
class Sweep {
  private readonly previous = new Map<Scope, ScopeState>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  // Only the latest run evaluates: a config change mid-load supersedes the load in flight.
  private generation = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly deps: SweepDeps,
    private readonly backstopMs: number
  ) {
    this.unsubscribe = deps.cache.onInvalidate(() => {
      this.run();
    });
  }

  run(): void {
    clearTimeout(this.timer);
    this.generation += 1;
    const own = this.generation;
    this.deps.cache
      .get()
      .then(snapshot => {
        if (own !== this.generation || this.stopped) {
          return;
        }
        const next = tick(this.deps, snapshot, this.previous);
        this.arm(
          next === null ? this.backstopMs : next - Date.parse(this.deps.now())
        );
      })
      .catch((error: unknown) => {
        this.deps.log.error(
          { err: error },
          'ooo/hours sweep failed; retrying in 60 s'
        );
        if (own === this.generation) {
          this.arm(RETRY_MS);
        }
      });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    clearTimeout(this.timer);
  }

  private arm(delayMs: number): void {
    clearTimeout(this.timer);
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.run();
      },
      Math.max(0, Math.min(delayMs, this.backstopMs))
    );
  }
}

/**
 * Runs `tick` immediately against `deps.cache`'s current snapshot, then again at the next
 * transition instant it reports, at once after every config change (`ConfigCache.onInvalidate`),
 * and at the latest `backstopMs` (an hour by default) after the previous run. A run that fails
 * to load the snapshot is retried after a minute. `stop()` cancels the timer and the subscription.
 */
export function startSweep(
  deps: SweepDeps,
  backstopMs: number = DEFAULT_BACKSTOP_MS
): { stop: () => void } {
  const sweep = new Sweep(deps, backstopMs);
  sweep.run();
  return {
    stop(): void {
      sweep.stop();
    }
  };
}
