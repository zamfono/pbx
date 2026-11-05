/** Pipeline step 7 "Forward targets" (§10.1): hop counting, the hop a forward records for its
 * forwarded leg (§9.4 "Forwarded calls"), then `inbound.ts`'s dispatch of the target. */
import { nextHop, type ForwardTarget } from '../routing/targets.js';
import { SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { type Call } from './call.js';
import {
  noteDiversion,
  noteNumberForward,
  type Diversion
} from './forwardContext.js';
import type { Forwarder } from './forwardLeg.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';
import { endTargetOwner, type Owner } from './release.js';

/** Past the hop limit (`settings.max_forward_hops`): the last target's mailbox, else 480 (§10.1
 * step 7). */
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
  const snapshot = await pipeline.deps.cache.get();
  const hop = nextHop(call.hops, target, snapshot.settings.maxForwardHops);
  if (!hop.ok) {
    await endAtHopLimit(pipeline, call);
    return;
  }
  call.hops = hop.hops;
  noteDiversion(call, diversion);
  await enterTarget(pipeline, call, target, forwarder);
}

/**
 * §10.1 step 7: an `external`, `sip` or `webSocket` target that did not work, for `cause` (the
 * far end's final SIP status, or what kept it from answering), hands
 * the call to its fallback as if the rule had named that one: a user or ring group counts a hop
 * and re-enters, and `forwarder` still dials an external or SIP fallback as their own call. The
 * fallback adds no forward hop of its own, so the one that reached `target` stays the last. A
 * call whose answer joins another bridge (`*5`) never falls back, nor one whose caller hung up.
 * Whether the fallback took the call; without one the caller ends it as before.
 */
export async function failOver(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget,
  forwarder: Forwarder | null,
  cause: string | number
): Promise<boolean> {
  const fallback = 'fallback' in target ? target.fallback : undefined;
  if (
    fallback === undefined ||
    call.joinBridgeId !== undefined ||
    call.callerEnded === true
  ) {
    return false;
  }
  call.log.event({
    event: 'fallback',
    from: target.kind,
    cause,
    to: fallback.kind
  });
  await runTarget(pipeline, call, fallback, forwarder, null);
  return true;
}

/** An external target that is one of the tenant's own DIDs (§10.1 step 7): the DID's `target`
 * entered internally, as Outbound step 5 routes it, one hop on whatever its kind, so DIDs
 * forwarding to each other end at the hop limit. The DID forwards, so nobody's call is dialled,
 * and an `external` or `sip` target records the DID's hop (§9.4 "Forwarded calls"). */
export async function enterOwnDid(
  pipeline: Pipeline,
  call: Call,
  did: { id: string; target: ForwardTarget }
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  if (call.hops + 1 > snapshot.settings.maxForwardHops) {
    await endAtHopLimit(pipeline, call);
    return;
  }
  call.hops += 1;
  noteNumberForward(snapshot, call, { didId: did.id }, did.target);
  await enterTarget(pipeline, call, did.target, null);
}
