/**
 * Pickup (§10.1 "Transfers and pickup"; §9.3 `*8<ext>`): the picker's own answered channel takes
 * a ringing call's answer, joins its caller in a fresh bridge, and the call's ring stops. Shared
 * by the `*8<ext>` feature code, which finds the call by the extension it rings, and the API
 * pickup (`pickupAction.ts`), which names the call.
 */
import { ignoreGone, logUnlessGone } from '../ari/failures.js';
import { SIP_NOT_FOUND } from '../sipCodes.js';
import { bridgeAnswered, claimAnswer } from './answer.js';
import { callerChannel, type Call, type Leg } from './call.js';
import { findLiveCall } from './callLookup.js';
import { ownerForExt } from './extensionOwner.js';
import { closeFeatureCall } from './featureCall.js';
import { activeBatchHasRingingLeg, stopGroupRinging } from './groupPickup.js';
import type { Pipeline } from './pipeline.js';
import { release, type Owner } from './release.js';

/** How the call to pick up rings: its own ring race (`pendingRing`, a user's ring), or its ring
 * group's tracked batch (`groupPickup.ts`) with a leg ringing for `memberUserId`, any member's
 * for `null`. */
type PickupRing =
  { kind: 'direct' } | { kind: 'group'; memberUserId: string | null };

/** The one picking up: their answered channel, and their user. */
type Picker = { channelId: string; userId: string | null };

/** The picker's own channel as `target`'s answering leg (§10.1 "Pickup"): it stays up as the
 * picked-up call's answered leg, so the picker hanging up ends that call for its caller too.
 * Claimed (`answer.ts`) before anything stops the ring, so an answer already in flight keeps the
 * call, and `null` then. */
function claimPickup(
  pipeline: Pipeline,
  picker: Picker,
  target: Call
): Leg | null {
  const leg: Leg = {
    channelId: picker.channelId,
    kind: 'device',
    userId: picker.userId,
    state: 'up',
    endCause: null
  };
  return claimAnswer(pipeline, target, leg, { pickup: true }) ? leg : null;
}

/** The picked-up call's own bridging: the picker's channel joins `target`'s in a fresh bridge,
 * every other still-ringing leg of `target` ends, and `target`'s own ringing user (a direct
 * pickup) or ring-group member (`stopGroupRinging`'s own hangups) returns to idle. */
async function bridgePickup(
  pipeline: Pipeline,
  picker: Picker,
  target: Call,
  leg: Leg
): Promise<void> {
  const ari = pipeline.deps.ari;
  await ari.channels.answer(picker.channelId).catch(ignoreGone);
  const joined = await bridgeAnswered(pipeline, target, leg);
  for (const other of target.legs.values()) {
    if (other.state === 'ringing') {
      other.state = 'ended';
      pipeline.callByChannel.delete(other.channelId);
      // eslint-disable-next-line no-await-in-loop -- a handful of legs at most, hung up one at a time
      await ari.channels.hangup(other.channelId).catch(
        logUnlessGone(pipeline.deps.logger, 'ringing leg hangup', {
          callId: target.id
        })
      );
    }
  }
  // Presence (§9.3, §10.2 "Presence and BLF"): the ringing callee idle, the picker in the call once bridged.
  if (target.calleeUserId !== null) {
    pipeline.deps.presence.setCallState(
      target.calleeUserId,
      'idle',
      null,
      null,
      target.id
    );
  }
  if (picker.userId !== null && joined) {
    pipeline.deps.presence.setCallState(
      picker.userId,
      'inCall',
      target.from,
      null,
      target.id
    );
  }
  // §7 level `sip`: the picker's dialog is `target`'s answered leg now.
  pipeline.deps.cdr.dialogs.registerLeg(target, picker.channelId);
}

/**
 * The picker takes `target`, ringing as `ring` says, from its ring race: whether they did. Runs
 * no await before the claim and the ring's stop, so a caller that just found `target` ringing
 * stops the very ring it found.
 */
export async function pickUp(
  pipeline: Pipeline,
  target: Call,
  ring: PickupRing,
  picker: Picker
): Promise<boolean> {
  const leg = claimPickup(pipeline, picker, target);
  if (leg === null) {
    return false;
  }
  if (ring.kind === 'group') {
    stopGroupRinging(pipeline, target, ring.memberUserId);
    await bridgePickup(pipeline, picker, target, leg);
    return true;
  }
  const pending = pipeline.pendingRing.get(target.id);
  if (pending !== undefined) {
    clearTimeout(pending.timer);
    pipeline.pendingRing.delete(target.id);
  }
  // A find-me leg's own timer, if any, no-ops on firing (guards on `pendingRing`, cleared above).
  await bridgePickup(pipeline, picker, target, leg);
  pending?.resolve('answered');
  return true;
}

/** How `call` rings for a pickup right now, and whom it rings: its ring group's batch, any
 * member's leg, or its callee's own ring race; `null` once it stopped ringing. */
export function pickupRingOf(
  pipeline: Pipeline,
  call: Call
): { ring: PickupRing; rings: Owner } | null {
  const { ringGroupId, calleeUserId } = call;
  if (
    ringGroupId !== null &&
    activeBatchHasRingingLeg(pipeline, call.id, null)
  ) {
    return {
      ring: { kind: 'group', memberUserId: null },
      rings: { ringGroupId }
    };
  }
  if (calleeUserId !== null && pipeline.pendingRing.has(call.id)) {
    return { ring: { kind: 'direct' }, rings: { userId: calleeUserId } };
  }
  return null;
}

/** `*8<ext>`: wins the target's ring race for the picker's own channel (§10.1 "Pickup"): a
 * single user's own ring race (`pendingRing`), or a ring group's own tracked batch
 * (`stopGroupRinging`) when `ext` is a member's extension or the group's own (§9.3 table). The
 * feature dial's own row closes answered once its channel is the picked-up call's leg. */
export async function pickupByExtension(
  pipeline: Pipeline,
  call: Call,
  ext: string
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const owner = ownerForExt(snapshot, ext);
  // An extension nobody owns — unknown, or a parking slot — names no ringing call to pick up
  // (§9.3 table: `*8<ext>` is directed pickup); falling through to the group search below with
  // both `userId` and `groupId` null would otherwise match any live ring-group call at all.
  if (owner === null) {
    await release(pipeline, call, SIP_NOT_FOUND, 'failed');
    return;
  }
  const userId = 'userId' in owner ? owner.userId : null;
  const groupId = 'ringGroupId' in owner ? owner.ringGroupId : null;
  const picker = { channelId: callerChannel(call), userId: call.callerUserId };

  if (userId !== null) {
    const target = findLiveCall(
      pipeline,
      candidate =>
        pipeline.pendingRing.has(candidate.id) &&
        candidate.calleeUserId === userId
    );
    if (
      target !== null &&
      (await pickUp(pipeline, target, { kind: 'direct' }, picker))
    ) {
      await closeFeatureCall(pipeline, call, 'answered');
      return;
    }
  }

  // Constrained to a call whose tracked batch actually has a leg ringing for `userId` (any member
  // when `ext` is the group's own extension, `userId === null`), not merely any live ring-group
  // call, so a member ringing in one group is never picked up out of another's.
  const groupTarget = findLiveCall(
    pipeline,
    candidate =>
      candidate.ringGroupId !== null &&
      (groupId === null || candidate.ringGroupId === groupId) &&
      activeBatchHasRingingLeg(pipeline, candidate.id, userId)
  );
  if (
    groupTarget !== null &&
    (await pickUp(
      pipeline,
      groupTarget,
      { kind: 'group', memberUserId: userId },
      picker
    ))
  ) {
    await closeFeatureCall(pipeline, call, 'answered');
    return;
  }

  await release(pipeline, call, SIP_NOT_FOUND, 'failed');
}
