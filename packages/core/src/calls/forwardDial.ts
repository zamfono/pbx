/**
 * §10.1 step 7's two outward targets: an `external` number, dialled through `outbound_routes` like
 * any outbound call (`outboundExternal.ts`), and a `sip` target, dialled over its own trunk with
 * no route to match (§9.4 "SIP targets"). Either leg carries the call's forwarding context (§9.4
 * "Forwarded calls").
 */
import { userById, type Snapshot } from '../internal/snapshot.js';
import type { ForwardTarget } from '../routing/targets.js';
import { shouldFallThrough } from '../routing/trunk.js';
import { SIP_SERVICE_UNAVAILABLE } from '../sipCodes.js';
import { settleAnswered } from './answer.js';
import { type Call } from './call.js';
import type { TrunkRow } from './callerIdentity.js';
import { concludeExhausted, concludeFinal } from './conclude.js';
import { attemptRoute } from './dialAttempt.js';
import type { ForwardLeg } from './forwardContext.js';
import { sipForwardLeg } from './forwardValues.js';
import { dialExternal } from './outboundExternal.js';
import type { Pipeline } from './pipeline.js';
import { release } from './release.js';
import { liveTrunk, prepareRoute } from './routeSelection.js';
import { dialTargets } from './trunkDial.js';
import type { TrunkState } from './trunkState.js';

type SipTarget = Extract<ForwardTarget, { kind: 'sip' }>;

/** Why `trunk` cannot carry a SIP target at all (§9.4 "SIP targets"), else `null`. */
function unusableCause(
  trunk: TrunkRow | undefined,
  snapshot: Snapshot
): 'trunkMissing' | 'noOutboundHost' | null {
  if (trunk === undefined) {
    return 'trunkMissing';
  }
  return dialTargets(trunk, snapshot).length === 0 ? 'noOutboundHost' : null;
}

/**
 * Dials `target.user` over `target.trunkId` alone (§9.4 "SIP targets"): the trunk's pre-checks and
 * the caller identity as a route-less attempt, every outbound host in turn for an `ip` trunk, then
 * the answer or the release the last route's failure would give. A trunk soft-deleted since, or
 * one with no outbound host, is released with 503 as an external forward no route carries.
 */
async function dialSipTarget(
  ctx: { pipeline: Pipeline; trunkState: TrunkState },
  call: Call,
  target: SipTarget,
  asUser: string | null
): Promise<void> {
  const { pipeline, trunkState } = ctx;
  const snapshot = await pipeline.deps.cache.get();
  const trunk = liveTrunk(snapshot, target.trunkId);
  const unusable = unusableCause(trunk, snapshot);
  if (trunk === undefined || unusable !== null) {
    call.log.event({
      event: 'sipTarget',
      trunkId: target.trunkId,
      cause: unusable
    });
    await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
    return;
  }
  const callerUser = userById(snapshot, asUser);
  const prepared = prepareRoute({
    pipeline,
    trunkState,
    call,
    route: null,
    trunk,
    callerUser,
    clirPerCall: null,
    snapshot
  });
  if (!prepared.ok) {
    await concludeExhausted(pipeline, call, prepared.failure.kind);
    return;
  }
  const forward = await sipForwardLeg(
    pipeline,
    call,
    target,
    [...call.diversions],
    snapshot
  );
  const outcome = await attemptRoute(
    {
      pipeline,
      call,
      trunkState,
      route: null,
      trunk,
      number: target.user,
      identity: prepared.identity,
      forward
    },
    snapshot
  );
  if (outcome.kind === 'answered') {
    await settleAnswered(pipeline, call, outcome.channelId);
    return;
  }
  await (shouldFallThrough(outcome.failure)
    ? concludeExhausted(pipeline, call, outcome.failure.kind)
    : concludeFinal(pipeline, call, outcome.failure));
}

/**
 * §10.1 step 7: an external or SIP forward target, dialled "as the forwarding user's call":
 * `asUser` is the user whose own rule forwarded, not the original caller, and `null` when a DID,
 * menu, ring group or tenant rule forwards, which picks the routes of an external number and the
 * presented number and CLIR of either (§9.4). The leg carries the hops so far. A pipeline with no
 * trunk state cannot reach a trunk at all, and releases rather than pretending to try.
 */
export async function dialForwardTarget(
  pipeline: Pipeline,
  call: Call,
  target: Extract<ForwardTarget, { kind: 'external' | 'sip' }>,
  asUser: string | null
): Promise<void> {
  const { trunkState } = pipeline.deps;
  if (target.kind === 'sip') {
    await dialSipTarget({ pipeline, trunkState }, call, target, asUser);
    return;
  }
  // An external forward carries `Diversion` alone (§9.4 "Forwarded calls").
  const forward: ForwardLeg = { diversions: [...call.diversions], headers: [] };
  await dialExternal(
    { pipeline, trunkState, forward },
    call,
    target.number,
    asUser,
    null
  );
}
