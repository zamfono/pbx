/**
 * Decisions in a running core (§10.1 step 7 "Decisions"): what they read, the tenant clock, the
 * party on a call's caller channel, and a user's effective status, the user's own OOO rule
 * (`away`), then the user's own opening hours (`closed`), then the presence core publishes (§10.2
 * "Presence and BLF"), so a decision and `/events` never disagree on the latter; and their
 * resolution on a call's path.
 */
import {
  resolveTenantTimeZone,
  type DecisionStatus,
  type Presence
} from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';
import {
  resolveDecisions,
  type DecisionInputs,
  type Resolution
} from '../routing/decision.js';
import { isOpen, ownInEffectOoo } from '../routing/schedule.js';
import { buildOooRules, buildSchedules } from '../routing/scheduleRows.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { Call } from './call.js';
import { presentCallerUserId } from './callLookup.js';
import { templateValues } from './forwardValues.js';
import type { Pipeline } from './pipeline.js';

/** `userId`'s effective status at `now`: tenant-wide OOO and hours are the tenant's, not the
 * user's, and do not count. `overrides` stand in for the status published (the dry run's). */
export function effectiveStatus(
  snapshot: Snapshot,
  presence: ReadonlyMap<string, Presence>,
  clock: { now: string; timezone: string },
  overrides: Readonly<Record<string, DecisionStatus>> = {}
): (userId: string) => DecisionStatus {
  const scopeOf = (userId: string): `user:${string}` => `user:${userId}`;
  const rules = buildOooRules(snapshot.oooRules);
  const schedules = buildSchedules(
    snapshot.openingHours,
    snapshot.openingHoursIntervals
  );
  return userId => {
    const override = overrides[userId];
    if (override !== undefined) {
      return override;
    }
    if (ownInEffectOoo(rules, scopeOf(userId), clock.now) !== null) {
      return 'away';
    }
    const own = schedules.find(
      schedule => schedule.scope === scopeOf(userId) && schedule.active
    );
    if (own !== undefined && !isOpen(own, clock.now, clock.timezone)) {
      return 'closed';
    }
    return presence.get(userId)?.status ?? 'offline';
  };
}

/** The tenant clock: now, in `settings.timezone`, else the stack's. */
export function tenantClock(
  snapshot: Snapshot,
  deps: { now: () => string; stackTz: string }
): { now: string; timezone: string } {
  return {
    now: deps.now(),
    timezone: resolveTenantTimeZone(snapshot.settings.timezone, deps.stackTz)
  };
}

/** What a decision reached by `call` reads, and a target's templates: the user on its caller
 * channel, else its number, and the call's template values (§9.4 "Templates"). */
export async function callDecisionInputs(
  snapshot: Snapshot,
  pipeline: Pipeline,
  call: Call
): Promise<DecisionInputs> {
  const clock = tenantClock(snapshot, pipeline.deps);
  return {
    ...clock,
    caller: { userId: presentCallerUserId(call), number: call.from },
    statusOf: effectiveStatus(snapshot, pipeline.deps.state.presence, clock),
    values: await templateValues(pipeline, call, snapshot)
  };
}

/**
 * §10.1 step 7: `target` resolved through the decisions it leads to on `call`'s path, the one place
 * a decision is evaluated for a call: met again since the last clearing event (`call.decisionsSeen`,
 * "Loops"), or evaluated, one trace line each, and its chosen target taken as if the rule had
 * named it; and the one place a target's templates are rendered for it ("Templates").
 */
export async function resolveOnCall(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget
): Promise<Resolution> {
  const snapshot = await pipeline.deps.cache.get();
  return resolveDecisions(
    snapshot,
    target,
    await callDecisionInputs(snapshot, pipeline, call),
    call.decisionsSeen,
    evaluation => {
      call.log.event({
        event: 'decision',
        decisionId: evaluation.decisionId,
        decisionCase: evaluation.caseIndex ?? 'default'
      });
    }
  );
}
