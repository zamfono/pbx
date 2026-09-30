/**
 * Steps 2 and 3 of the inbound pipeline (§10.1): the out-of-office rule in effect for a target's
 * scope, then its opening-hours schedule. Either one ends the call at its own forward target.
 */
import { resolveTenantTimeZone, type Scope } from '@zamfono/shared';

import type { Snapshot } from '../internal/server.js';
import { inEffectOoo, isOpen, scheduleFor } from '../routing/schedule.js';
import { buildOooRules, buildSchedules } from '../routing/scheduleRows.js';
import { findForwardTarget, type Call, type Owner } from './call.js';
import {
  diversionFor,
  type DivertingParty,
  type RedirectingReason
} from './forwardContext.js';
import type { Pipeline } from './pipeline.js';

type ScopedTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'ringGroup'; ringGroupId: string }
  | { kind: 'menu'; menuId: string };

/** The OOO/hours scope and mailbox owner a scoped target represents; a menu has neither owner. */
export function targetIdentity(target: ScopedTarget): {
  scope: Scope;
  owner: Owner | null;
} {
  if (target.kind === 'user') {
    return { scope: `user:${target.userId}`, owner: { userId: target.userId } };
  }
  if (target.kind === 'ringGroup') {
    const owner = { ringGroupId: target.ringGroupId };
    return { scope: `ringGroup:${target.ringGroupId}`, owner };
  }
  return { scope: `menu:${target.menuId}`, owner: null };
}

/** The user whose own rule a `scope`'s OOO rule or schedule is, whose call an external target it
 * forwards to is dialled as (§10.1 step 7); `null` for a ring group, menu or tenant rule. */
function scopeUser(scope: Scope): string | null {
  return scope.startsWith('user:') ? scope.slice('user:'.length) : null;
}

/** The hop an OOO rule or a closed schedule makes (§9.4 "Forwarded calls"): the call's target,
 * `scope`, is the party diverting it, whichever scope the rule itself belongs to. */
function scheduleDiversion(
  snapshot: Snapshot,
  call: Call,
  scope: Scope,
  reason: RedirectingReason
): ReturnType<typeof diversionFor> {
  const [kind, id = ''] = scope.split(':');
  let party: DivertingParty | null = null;
  if (kind === 'user') {
    party = { userId: id };
  } else if (kind === 'ringGroup') {
    party = { ringGroupId: id };
  } else if (kind === 'menu') {
    party = { menuId: id };
  }
  return party === null ? null : diversionFor(snapshot, call, party, reason);
}

/** Steps 2-3, OOO then opening hours (skipped for internal calls): the first applicable forward target ends the call, returning true. */
export async function applyOooAndHours(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  scope: Scope
): Promise<boolean> {
  const ooo = inEffectOoo(
    buildOooRules(snapshot.oooRules),
    scope,
    pipeline.deps.now()
  );
  call.log.event({ event: 'ooo', scope, active: ooo !== null });
  if (ooo) {
    await pipeline.runTarget(
      call,
      findForwardTarget(snapshot, ooo.targetId),
      scopeUser(ooo.scope),
      scheduleDiversion(snapshot, call, scope, 'away')
    );
    return true;
  }
  if (call.direction === 'internal') {
    return false;
  }
  const schedule = scheduleFor(
    buildSchedules(snapshot.openingHours, snapshot.openingHoursIntervals),
    scope
  );
  if (schedule === null) {
    // §7 "OOO evaluation": a trace that shows no hours line would not say whether they were
    // evaluated at all.
    call.log.event({ event: 'hours', scope, schedule: null });
    return false;
  }
  // A zone `Intl` cannot use falls back rather than throwing, which would leave the call unrouted.
  const timezone = resolveTenantTimeZone(
    snapshot.settings.timezone,
    pipeline.deps.stackTz
  );
  const open = isOpen(schedule, pipeline.deps.now(), timezone);
  // `schedule` is the scope whose opening hours applied: the target's own, else the tenant's.
  call.log.event({ event: 'hours', scope, schedule: schedule.scope, open });
  if (open) {
    return false;
  }
  await pipeline.runTarget(
    call,
    findForwardTarget(snapshot, schedule.closedTargetId),
    scopeUser(schedule.scope),
    scheduleDiversion(snapshot, call, scope, 'time_of_day')
  );
  return true;
}
