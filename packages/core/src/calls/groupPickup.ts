/**
 * `*8<ext>` on a ring group (§10.1 "Pickup"; §9.3 table), its own module so `ringGroupDial.ts`
 * stays under the repository's `max-lines` lint rule. One registry per `Pipeline`: the batch
 * currently ringing for a call, so `features.ts`'s `pickup` can stop a ring group's ring race
 * from outside `ringGroupDial.ts`. Populated for the lifetime of one `ringBatch` call; a call
 * rings at most one batch at a time (`ringGroup.ts`'s own sequential loop).
 */
import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import type { BatchOutcome } from './ringGroupDial.js';
import type { GroupLeg } from './ringGroupOriginate.js';

export type ActiveBatch = {
  tracked: Map<string, GroupLeg>;
  settle: (outcome: BatchOutcome) => void;
};
const activeBatchByPipeline = new WeakMap<Pipeline, Map<string, ActiveBatch>>();

/** `ringBatch`'s own bookkeeping: registers its batch as the one `stopGroupRinging` can reach for `call.id`. */
export function registerActiveBatch(
  pipeline: Pipeline,
  callId: string,
  active: ActiveBatch
): void {
  let batches = activeBatchByPipeline.get(pipeline);
  if (batches === undefined) {
    batches = new Map();
    activeBatchByPipeline.set(pipeline, batches);
  }
  batches.set(callId, active);
}

/** `ringBatch`'s own bookkeeping: clears `call.id`'s entry once its batch settles. */
export function unregisterActiveBatch(
  pipeline: Pipeline,
  callId: string
): void {
  activeBatchByPipeline.get(pipeline)?.delete(callId);
}

/** Whether `call`'s own tracked batch, if any, has a leg still ringing for `memberUserId` — any
 * member when `null` — so `features.ts`'s `pickup` only picks a call that is actually ringing the
 * named extension, rather than any live ring-group call at all (§10.1 "Pickup"). */
export function activeBatchHasRingingLeg(
  pipeline: Pipeline,
  callId: string,
  memberUserId: string | null
): boolean {
  const active = activeBatchByPipeline.get(pipeline)?.get(callId);
  if (active === undefined) {
    return false;
  }
  return [...active.tracked.values()].some(
    leg =>
      leg.state === 'ringing' &&
      (memberUserId === null || leg.userId === memberUserId)
  );
}

/**
 * Stops `call`'s currently-ringing batch (§10.1 "Pickup"): the leg matching `memberUserId` when
 * given, else any ringing leg — a pickup by the group's own extension. Every other still-ringing
 * leg in the batch is hung up too and the group's hold music stopped, the same as a normal win
 * (§10.1 step 5's "the other legs are hung up"), and the batch settles `answered` so
 * `ringGroup.ts`'s loop applies no fallback. The caller does its own bridging (`features.ts`'s
 * `pickup`), since the picker's own channel — not the stopped leg's — carries the conversation.
 */
export function stopGroupRinging(
  pipeline: Pipeline,
  call: Call,
  memberUserId: string | null
): { channelId: string; userId: string | null } | null {
  const active = activeBatchByPipeline.get(pipeline)?.get(call.id);
  if (active === undefined) {
    return null;
  }
  const entry = [...active.tracked].find(
    ([, leg]) =>
      leg.state === 'ringing' &&
      (memberUserId === null || leg.userId === memberUserId)
  );
  if (entry === undefined) {
    return null;
  }
  const [stoppedChannelId, stoppedLeg] = entry;
  // The group's hold music replaced ringback while its members rang (§10.2 "Ring groups"); a
  // batch's own win stops it (`winBatch`), and so does this. Requested before the caller's
  // bridging, which the caller then does.
  pipeline.deps.ari.channels
    .stopMoh(call.callerChannelId)
    .catch(() => undefined);
  for (const [channelId, leg] of active.tracked) {
    if (leg.state === 'ringing') {
      leg.state = 'ended';
      pipeline.deps.ari.channels.hangup(channelId).catch(() => undefined);
    }
  }
  active.settle('answered');
  return { channelId: stoppedChannelId, userId: stoppedLeg.userId };
}
