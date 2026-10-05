/** Pipeline step 7 "Forward targets" (§10.1): hop counting, the hop a forward records for its
 * forwarded leg (§9.4 "Forwarded calls"), then `inbound.ts`'s dispatch of the target. */
import { MAX_HOPS, nextHop, type ForwardTarget } from '../routing/targets.js';
import { SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { type Call } from './call.js';
import {
  noteDiversion,
  type Diversion,
  type Forwarder
} from './forwardContext.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';
import { endTargetOwner, type Owner } from './release.js';

/** After the third hop: the last target's mailbox, else 480 (§10.1 step 7). */
async function endAtHopLimit(pipeline: Pipeline, call: Call): Promise<void> {
  call.log.event({ event: 'hopLimit', hops: call.hops });
  const snapshot = await pipeline.deps.cache.get();
  let owner: Owner | null = null;
  if (call.calleeUserId !== null) {
    owner = { userId: call.calleeUserId };
  } else if (call.ringGroupId !== null) {
    owner = { ringGroupId: call.ringGroupId };
  }
  await endTargetOwner(pipeline, call, owner, snapshot, {
    code: SIP_TEMPORARILY_UNAVAILABLE,
    status: 'missed',
    reason: 'hopLimit'
  });
}

/** Step 7 "Forward targets": hop counting, then dispatch, or the hop-limit mailbox fallback.
 * `forwarder` is `enterTarget`'s: the forwarding user, `null` for a forward nobody's own rule made.
 * `diversion` is the forward hop this is, `null` for a forward that diverts nobody (a menu's
 * fallback, a parked call's), recorded once the hop limit let it through. */
export async function runTarget(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget,
  forwarder: Forwarder | null,
  diversion: Diversion | null
): Promise<void> {
  const hop = nextHop(call.hops, target);
  if (!hop.ok) {
    await endAtHopLimit(pipeline, call);
    return;
  }
  call.hops = hop.hops;
  noteDiversion(call, diversion);
  await enterTarget(pipeline, call, target, forwarder);
}

/** An external target that is one of the tenant's own DIDs (§10.1 step 7): the DID's `target`
 * entered internally, as Outbound step 5 routes it, one hop on whatever its kind, so DIDs
 * forwarding to each other end at the hop limit. The DID forwards, so nobody's call is dialled. */
export async function enterOwnDid(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget
): Promise<void> {
  if (call.hops + 1 > MAX_HOPS) {
    await endAtHopLimit(pipeline, call);
    return;
  }
  call.hops += 1;
  await enterTarget(pipeline, call, target, null);
}
