/**
 * `*8<ext>` on a ring group (§10.1 "Pickup"; §9.3 table), its own module so `ringGroupDial.ts`
 * stays under the repository's `max-lines` lint rule. The `Pipeline`'s `activeBatches` hold the
 * batch currently ringing for a call, so a pickup (`pickup.ts`) and a decline can reach a ring
 * group's ring race from outside `ringGroupDial.ts`, which sets the entry for the lifetime of one
 * `ringBatch` call; a call rings at most one batch at a time (`ringGroup.ts`'s own sequential
 * loop).
 */
import { logUnlessGone } from '../ari/failures.js';
import type { Call } from './call.js';
import type { GroupLeg } from './groupLegs.js';
import type { Pipeline } from './pipeline.js';
import type { BatchOutcome } from './ringGroupRace.js';

export type ActiveBatch = {
  tracked: Map<string, GroupLeg>;
  settle: (outcome: BatchOutcome) => void;
  /** A member leg ended with Q.850 `cause`, as the batch's own race handles it (`ringGroupRace.ts`). */
  endLeg: (leg: GroupLeg, cause: number | null) => void;
};
/** Whether `call`'s own tracked batch, if any, has a leg still ringing for `memberUserId` — any
 * member when `null` — so `features.ts`'s `pickup` only picks a call that is actually ringing the
 * named extension, rather than any live ring-group call at all (§10.1 "Pickup"). */
export function activeBatchHasRingingLeg(
  pipeline: Pipeline,
  callId: string,
  memberUserId: string | null
): boolean {
  const active = pipeline.activeBatches.get(callId);
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
  const active = pipeline.activeBatches.get(call.id);
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
  if (call.callerChannelId !== null) {
    pipeline.deps.ari.channels.stopMoh(call.callerChannelId).catch(
      logUnlessGone(pipeline.deps.logger, 'caller hold music stop', {
        callId: call.id
      })
    );
  }
  for (const [channelId, leg] of active.tracked) {
    if (leg.state === 'ringing') {
      leg.state = 'ended';
      pipeline.deps.ari.channels.hangup(channelId).catch(
        logUnlessGone(pipeline.deps.logger, 'ringing leg hangup', {
          callId: call.id
        })
      );
    }
  }
  active.settle('answered');
  return { channelId: stoppedChannelId, userId: stoppedLeg.userId };
}

/**
 * Declines `memberUserId`'s legs in `call`'s currently-ringing batch as their phones' own 603
 * would (§10.1 step 5, `decline.ts`): each ends through the batch's race with `cause`, so the
 * group's `allow_reject` decides what follows, and its channel is hung up.
 */
export function declineInBatch(
  pipeline: Pipeline,
  call: Call,
  memberUserId: string,
  cause: number
): void {
  const active = pipeline.activeBatches.get(call.id);
  const ringing = [...(active?.tracked.values() ?? [])].filter(
    leg => leg.state === 'ringing' && leg.userId === memberUserId
  );
  for (const leg of ringing) {
    // With `allow_reject` the first decline already hung up the member's other legs.
    if (leg.state === 'ringing') {
      active?.endLeg(leg, cause);
      pipeline.deps.ari.channels.hangup(leg.channelId).catch(
        logUnlessGone(pipeline.deps.logger, 'ringing leg hangup', {
          callId: call.id
        })
      );
    }
  }
}
