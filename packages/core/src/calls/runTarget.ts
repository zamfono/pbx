/** Pipeline step 7 "Forward targets" (§10.1): hop counting, the hop a forward records for its
 * forwarded leg (§9.4 "Forwarded calls"), then `inbound.ts`'s dispatch of the target. */
import { nextHop, type ForwardTarget } from '../routing/targets.js';
import { SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { type Call } from './call.js';
import { resolveOnCall } from './callDecisions.js';
import { noteDiversion, type Diversion } from './forwardContext.js';
import type { Forwarder } from './forwardLeg.js';
import { enterResolved, enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';
import { endTargetOwner, type Owner } from './release.js';

/** Past the hop limit (`settings.max_forward_hops`): the last target's mailbox, else 480 (§10.1
 * step 7), `trace` saying why. */
async function endAtHopLimit(
  pipeline: Pipeline,
  call: Call,
  trace: Record<string, unknown> = { event: 'hopLimit', hops: call.hops }
): Promise<void> {
  call.log.event(trace);
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

/** A decision met again since the last clearing event ends the call as at the hop limit (§10.1
 * step 7 "Loops"), with a trace line naming it. */
export async function endAtDecisionLoop(
  pipeline: Pipeline,
  call: Call,
  decisionId: string
): Promise<void> {
  await endAtHopLimit(pipeline, call, { event: 'decisionLoop', decisionId });
}

/** What a target is applied for: the forward hop it is, `null` for a forward that diverts nobody
 * (a menu's fallback, a parked call's, a fallback), recorded once the hop limit let it through;
 * and whether an OOO rule, a closed schedule, a user's or a group's rule forwards, which clears
 * the decisions met so far (§10.1 step 7 "Loops"). */
export type Forward = { diversion: Diversion | null; rule: boolean };

/** A forward that is no rule's and diverts nobody. */
export const PLAIN_FORWARD: Forward = { diversion: null, rule: false };

/** Step 7 "Forward targets": the target's decisions resolved (`resolveOnCall`), hop counting on the
 * target they resolve to, then dispatch, or the hop-limit mailbox fallback. `forwarder` is
 * `enterTarget`'s: the forwarding user, `null` for a forward nobody's own rule made. */
export async function runTarget(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget,
  forwarder: Forwarder | null,
  forward: Forward
): Promise<void> {
  if (forward.rule) {
    call.decisionsSeen.clear();
  }
  const resolution = await resolveOnCall(pipeline, call, target);
  if (resolution.kind === 'loop') {
    await endAtDecisionLoop(pipeline, call, resolution.decisionId);
    return;
  }
  const snapshot = await pipeline.deps.cache.get();
  const hop = nextHop(
    call.hops,
    resolution.target,
    snapshot.settings.maxForwardHops
  );
  if (!hop.ok) {
    await endAtHopLimit(pipeline, call);
    return;
  }
  if (hop.hops > call.hops) {
    call.decisionsSeen.clear();
  }
  call.hops = hop.hops;
  noteDiversion(call, forward.diversion);
  await enterResolved(pipeline, call, resolution, forwarder);
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
  await runTarget(pipeline, call, fallback, forwarder, PLAIN_FORWARD);
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
  call.decisionsSeen.clear();
  await enterTarget(pipeline, call, did.target, null, { didId: did.id });
}
