/**
 * The external-number dialling engine (§9.4 "Outbound routing", "Route fallthrough"), its own
 * module so `outbound.ts` stays under the repository's `max-lines` lint rule. `dialExternal` is
 * outbound step 6's own call settlement; `originateExternalLeg` is the same route-matching and
 * attempt loop for a caller that joins the answered leg into a bridge of its own, `features.ts`'s
 * `addParty` for `*5` to an external number (§10.2 "Three-way calls"). The route match and each
 * route's pre-checks are `routeSelection.ts`'s.
 */
import type { Snapshot } from '../internal/server.js';
import {
  shouldFallThrough,
  type AttemptFailure,
  type Route
} from '../routing/trunk.js';
import { settleAnswered } from './answer.js';
import { release, type Call } from './call.js';
import type { TrunkRow } from './callerIdentity.js';
import { concludeExhausted, concludeFinal } from './conclude.js';
import { attemptRoute, type AttemptOutcome } from './dialAttempt.js';
import type { Pipeline } from './pipeline.js';
import { prepareRoute, routesFor, routeTrunk } from './routeSelection.js';
import type { TrunkState } from './trunkState.js';

/** One route's pre-checks (reachability, cap, CLIR) then its attempt, or the pre-check's failure.
 * Caller-ID and CLIR are `asUser`'s, the user the call is made as, the same one whose caller
 * lists admitted the route (§9.4 "Outbound routing"). */
async function tryRoute(params: {
  pipeline: Pipeline;
  trunkState: TrunkState;
  call: Call;
  route: Route;
  trunk: TrunkRow;
  number: string;
  asUser: string | null;
  clirPerCall: boolean | null;
  snapshot: Snapshot;
}): Promise<AttemptOutcome> {
  const { pipeline, trunkState, call, route, trunk, number, asUser, snapshot } =
    params;
  const callerUser =
    asUser === null
      ? null
      : (snapshot.users.find(row => row.id === asUser) ?? null);
  const prepared = prepareRoute({ ...params, callerUser });
  if (!prepared.ok) {
    return { kind: 'failure', failure: prepared.failure };
  }
  return attemptRoute(
    {
      pipeline,
      call,
      trunkState,
      route,
      trunk,
      number,
      identity: prepared.identity
    },
    snapshot
  );
}

/** `originateExternalLeg`'s outcome: an answered leg, a final (non-fallthrough) failure, or the
 * route list exhausted — the same three cases `dialExternal`'s own settlement distinguishes, and
 * `features.ts`'s `addParty` (§10.2 "Three-way calls") joins the answered leg into the caller's
 * own bridge in place of `dialExternal`'s call-settlement. */
export type ExternalDialResult =
  | { kind: 'answered'; channelId: string }
  | { kind: 'final'; failure: AttemptFailure }
  | { kind: 'exhausted'; lastFailureKind: AttemptFailure['kind'] | null };

/**
 * `number`'s matching routes in priority order (§9.4 "Outbound routing"), skipping an unreachable
 * or capped trunk or one that cannot carry a withheld call, attempting each in turn and falling
 * through per §9.4 "Route fallthrough" until one answers or the list is exhausted. The call is
 * made as `asUser` — route caller lists, presented number and CLIR are all theirs, `null` for a
 * leg dialled on nobody's behalf — which need not be `call.callerUserId`: a transfer is the
 * transferrer's call, a forward the forwarding user's (§9.4 "Outbound routing", §10.1). `call`'s
 * own log and legs record every attempt regardless of who dials it — `dialExternal`'s own
 * outbound step 6, or `addParty`'s `*5` to an external number.
 */
export async function originateExternalLeg(
  ctx: { pipeline: Pipeline; trunkState: TrunkState },
  call: Call,
  number: string,
  asUser: string | null,
  clirPerCall: boolean | null
): Promise<ExternalDialResult> {
  const { pipeline, trunkState } = ctx;
  const snapshot = await pipeline.deps.cache.get();
  const matched = routesFor(snapshot, number, asUser);

  let lastFailureKind: AttemptFailure['kind'] | null = null;
  for (const route of matched) {
    const trunk = routeTrunk(snapshot, route);
    if (!trunk) {
      lastFailureKind = 'unreachable';
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- routes are attempted one at a time, in priority order, until one succeeds
    const attempted = await tryRoute({
      pipeline,
      trunkState,
      call,
      route,
      trunk,
      number,
      asUser,
      clirPerCall,
      snapshot
    });
    if (attempted.kind === 'answered') {
      return { kind: 'answered', channelId: attempted.channelId };
    }
    if (!shouldFallThrough(attempted.failure)) {
      return { kind: 'final', failure: attempted.failure };
    }
    lastFailureKind = attempted.failure.kind;
  }
  return { kind: 'exhausted', lastFailureKind };
}

/**
 * Dials `number` externally (§9.4 "Outbound routing"): the matching routes in priority order,
 * skipping an unreachable or capped trunk or one that cannot carry a withheld call, attempting
 * each in turn and falling through per §9.4 "Route fallthrough" until one answers or exhausted.
 */
export async function dialExternal(
  ctx: { pipeline: Pipeline; trunkState: TrunkState },
  call: Call,
  number: string,
  asUser: string | null,
  clirPerCall: boolean | null
): Promise<void> {
  const { pipeline } = ctx;
  const result = await originateExternalLeg(
    ctx,
    call,
    number,
    asUser,
    clirPerCall
  );
  if (result.kind === 'answered') {
    await settleAnswered(pipeline, call, result.channelId);
    return;
  }
  if (result.kind === 'final') {
    await concludeFinal(pipeline, call, result.failure);
    return;
  }
  await concludeExhausted(pipeline, call, result.lastFailureKind);
}

/**
 * §10.1 step 7: an external forward target is dialled out like any other outbound call, so §9.4's
 * route, trunk and caller-ID rules apply, "as the forwarding user's call": `asUser` is the user
 * whose own rule forwarded, not the original caller, and `null` when a DID, menu, ring group or
 * tenant rule forwards. A pipeline with no trunk state cannot reach a trunk at all, and releases
 * rather than pretending to try.
 */
const FORWARD_TARGET_UNAVAILABLE = 480;

export async function dialForwardTarget(
  pipeline: Pipeline,
  call: Call,
  number: string,
  asUser: string | null
): Promise<void> {
  const { trunkState } = pipeline.deps;
  if (trunkState === null) {
    await release(pipeline, call, FORWARD_TARGET_UNAVAILABLE, 'failed');
    return;
  }
  await dialExternal({ pipeline, trunkState }, call, number, asUser, null);
}
