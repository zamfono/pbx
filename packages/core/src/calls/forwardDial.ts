/**
 * §10.1 step 7's two outward targets: an `external` number, dialled through `outbound_routes` like
 * any outbound call (`outboundExternal.ts`), and a `sip` target, dialled over its own trunk with
 * no route to match (§9.4 "SIP targets"). Either leg carries the call's forwarding context (§9.4
 * "Forwarded calls").
 */
import { userById, type Snapshot } from '../internal/snapshot.js';
import { ownDidTarget, type ForwardTarget } from '../routing/targets.js';
import { SIP_SERVICE_UNAVAILABLE } from '../sipCodes.js';
import { type Call } from './call.js';
import type { TrunkRow } from './callerIdentity.js';
import { dialRoutes } from './dialAttempt.js';
import { openCursor, trunkWay } from './externalLegRoutes.js';
import {
  recordingOf,
  standInOf,
  type Forwarder,
  type ForwardLeg
} from './forwardContext.js';
import { sipForwardLeg } from './forwardValues.js';
import { dialExternal, settleDial } from './outboundExternal.js';
import type { Pipeline } from './pipeline.js';
import { release } from './release.js';
import { liveTrunk } from './routeSelection.js';
import { enterOwnDid } from './runTarget.js';
import type { TrunkChannels } from './trunkChannels.js';
import { dialTargets } from './trunkDial.js';

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
  ctx: { pipeline: Pipeline; trunkChannels: TrunkChannels },
  call: Call,
  target: SipTarget,
  forwarder: Forwarder | null
): Promise<void> {
  const { pipeline, trunkChannels } = ctx;
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
  const forward: ForwardLeg = {
    ...(await sipForwardLeg(
      pipeline,
      call,
      target,
      [...call.diversions],
      snapshot
    )),
    ...standInOf(forwarder),
    ...recordingOf(target)
  };
  const cursor = openCursor(
    {
      pipeline,
      trunkChannels,
      call,
      snapshot,
      number: target.user,
      callerUser: userById(snapshot, forwarder?.userId ?? null),
      clirPerCall: null,
      forward
    },
    [trunkWay(snapshot, trunk.id)]
  );
  await settleDial(pipeline, call, await dialRoutes(cursor));
}

/**
 * §10.1 step 7: an external or SIP forward target, dialled "as the forwarding user's call":
 * `forwarder` is the user whose own rule forwarded, not the original caller, and `null` when a DID,
 * menu, ring group or tenant rule forwards, which picks the routes of an external number and the
 * presented number and CLIR of either (§9.4). An own DID is entered internally instead (`enterOwnDid`).
 * The leg carries the hops so far, stands in for a forwarder whose unconditional rule it is and is
 * recorded when the target records (§10.2 "Effective flag").
 */
export async function dialForwardTarget(
  pipeline: Pipeline,
  call: Call,
  target: Extract<ForwardTarget, { kind: 'external' | 'sip' }>,
  forwarder: Forwarder | null
): Promise<void> {
  const { trunkChannels } = pipeline.deps;
  if (target.kind === 'sip') {
    await dialSipTarget({ pipeline, trunkChannels }, call, target, forwarder);
    return;
  }
  const own = ownDidTarget(await pipeline.deps.cache.get(), target);
  if (own !== null) {
    await enterOwnDid(pipeline, call, own);
    return;
  }
  // An external forward carries `Diversion` alone (§9.4 "Forwarded calls").
  const forward: ForwardLeg = {
    diversions: [...call.diversions],
    headers: [],
    ...standInOf(forwarder),
    ...recordingOf(target)
  };
  await dialExternal(
    { pipeline, trunkChannels, forward },
    call,
    target.number,
    forwarder?.userId ?? null,
    null
  );
}
