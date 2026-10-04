/** Pipeline step 7 "Forward targets" (§10.1): hop counting, the hop a forward records for its
 * forwarded leg (§9.4 "Forwarded calls"), then `inbound.ts`'s dispatch of the target. */
import { nextHop, type ForwardTarget } from '../routing/targets.js';
import { SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { type Call } from './call.js';
import { noteDiversion, type Diversion } from './forwardContext.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';
import { endTargetOwner, type Owner } from './release.js';

/** Step 7 "Forward targets": hop counting, then dispatch, or the hop-limit mailbox fallback.
 * `asUser` is `enterTarget`'s: the forwarding user, `null` for a forward nobody's own rule made.
 * `diversion` is the forward hop this is, `null` for a forward that diverts nobody (a menu's
 * fallback, a parked call's), recorded once the hop limit let it through. */
export async function runTarget(
  pipeline: Pipeline,
  call: Call,
  target: ForwardTarget,
  asUser: string | null,
  diversion: Diversion | null
): Promise<void> {
  const hop = nextHop(call.hops, target);
  if (!hop.ok) {
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
    return;
  }
  call.hops = hop.hops;
  noteDiversion(call, diversion);
  await enterTarget(pipeline, call, target, asUser);
}
