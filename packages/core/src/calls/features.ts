/** Feature-code dispatch (§9.3 "Feature codes"; §10.1 "Transfers and pickup"; §10.2
 * "Three-way calls"). Mailbox DTMF access lives in `mailbox.ts`, call parking in `parking.ts` and
 * `*5` in `addParty.ts`, each its own module so this dispatcher stays under the repository's
 * `max-lines` lint rule. */
import type { FeatureCodeKey } from '@zamfono/shared';

import type { Presence } from '../presence.js';
import { addParty } from './addParty.js';
import { bridgeAnswered, claimAnswer } from './answer.js';
import { release, type Call, type Leg } from './call.js';
import { findLiveCall } from './callLookup.js';
import { ownerForExt } from './extensionOwner.js';
import {
  closeFeatureCall,
  concludeFeature,
  RELEASE_CODE_FORBIDDEN,
  RELEASE_CODE_NOT_FOUND
} from './featureCall.js';
import { mailboxAccess, ownVoicemail } from './mailbox.js';
import { park, parkingSlots, type ParkedEntry } from './parking.js';
import { retrieveParkedCall } from './parkingRetrieval.js';
import type { Pipeline } from './pipeline.js';
// --- Task 31 ---
import { activeBatchHasRingingLeg, stopGroupRinging } from './ringGroupDial.js';
// --- end Task 31 ---
import { deposit } from './voicemail.js';

// Re-exported at `features.js`, this task's own declared file, for `outbound.ts`'s parking-slot
// dispatch and Task 33's boot resync, even though their own bodies live in `parking.ts` and
// `parkingRetrieval.ts`.
export { parkingSlots, retrieveParkedCall, type ParkedEntry };

/** The picker's own channel as `target`'s answering leg (§10.1 "Pickup"): it stays up as the
 * picked-up call's answered leg, so the picker hanging up ends that call for its caller too.
 * Claimed (`answer.ts`) before anything stops the ring, so an answer already in flight keeps the
 * call, and `null` then. */
function claimPickup(pipeline: Pipeline, call: Call, target: Call): Leg | null {
  const leg: Leg = {
    channelId: call.callerChannelId,
    kind: 'device',
    userId: call.callerUserId,
    state: 'up',
    endCause: null
  };
  return claimAnswer(pipeline, target, leg, { pickup: true }) ? leg : null;
}

/** The picked-up call's own bridging: the picker's channel joins `target`'s in a fresh bridge,
 * every other still-ringing leg of `target` ends, and `target`'s own ringing user (a direct
 * pickup) or ring-group member (`stopGroupRinging`'s own hangups, item 4) returns to idle. */
async function bridgePickup(
  pipeline: Pipeline,
  call: Call,
  target: Call,
  leg: Leg
): Promise<void> {
  const ari = pipeline.deps.ari;
  await ari.channels.answer(call.callerChannelId).catch(() => undefined);
  await bridgeAnswered(pipeline, target, leg);
  for (const other of target.legs.values()) {
    if (other.state === 'ringing') {
      other.state = 'ended';
      pipeline.callByChannel.delete(other.channelId);
      // eslint-disable-next-line no-await-in-loop -- a handful of legs at most, hung up one at a time
      await ari.channels.hangup(other.channelId).catch(() => undefined);
    }
  }
  // --- Task 31 --- (§9.3, §10.2 "Presence and BLF")
  if (target.calleeUserId !== null) {
    pipeline.deps.presence?.setCallState(
      target.calleeUserId,
      'idle',
      null,
      null,
      target.id
    );
  }
  if (call.callerUserId !== null) {
    pipeline.deps.presence?.setCallState(
      call.callerUserId,
      'inCall',
      target.from,
      null,
      target.id
    );
  }
  // --- end Task 31 ---
  // §7 level `sip`: the picker's dialog is `target`'s answered leg now, not the closing `*8` dial's.
  pipeline.deps.cdr.registerLeg?.(target, call.callerChannelId);
  await closeFeatureCall(pipeline, call, 'answered');
}

/** `*8<ext>`: wins the target's ring race for the picker's own channel (§10.1 "Pickup"): a
 * single user's own ring race (`pendingRing`), or — Task 31, item 4 — a ring group's own tracked
 * batch (`ringGroupDial.ts`'s `stopGroupRinging`) when `ext` is a member's extension or the
 * group's own (§9.3 table). */
async function pickup(
  pipeline: Pipeline,
  call: Call,
  ext: string
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const owner = ownerForExt(snapshot, ext);
  // --- Task 31 ---
  // An extension nobody owns — unknown, or a parking slot — names no ringing call to pick up
  // (§9.3 table: `*8<ext>` is directed pickup); falling through to the group search below with
  // both `userId` and `groupId` null would otherwise match any live ring-group call at all.
  if (owner === null) {
    await release(pipeline, call, RELEASE_CODE_NOT_FOUND, 'failed');
    return;
  }
  // --- end Task 31 ---
  const userId = 'userId' in owner ? owner.userId : null;
  const groupId = 'ringGroupId' in owner ? owner.ringGroupId : null;

  if (userId !== null) {
    const target = findLiveCall(
      pipeline,
      candidate =>
        pipeline.pendingRing.has(candidate.id) &&
        candidate.calleeUserId === userId
    );
    const leg = target === null ? null : claimPickup(pipeline, call, target);
    if (target !== null && leg !== null) {
      const pending = pipeline.pendingRing.get(target.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pipeline.pendingRing.delete(target.id);
      }
      // A find-me leg's own timer, if any, no-ops on firing (guards on `pendingRing`, cleared above).
      await bridgePickup(pipeline, call, target, leg);
      pending?.resolve('answered');
      return;
    }
  }

  // --- Task 31 ---
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
  const groupLeg =
    groupTarget === null ? null : claimPickup(pipeline, call, groupTarget);
  if (groupTarget !== null && groupLeg !== null) {
    // Same tick as the search above, so the batch it matched is still ringing to be stopped.
    stopGroupRinging(pipeline, groupTarget, userId);
    await bridgePickup(pipeline, call, groupTarget, groupLeg);
    return;
  }
  // --- end Task 31 ---

  await release(pipeline, call, RELEASE_CODE_NOT_FOUND, 'failed');
}

/** `*90`/`*91`: writes `users.dnd` and refreshes the caller's own hint (§9.3, §3.1 cross-write). */
async function setDnd(
  pipeline: Pipeline,
  presence: Presence,
  call: Call,
  dnd: boolean
): Promise<void> {
  const db = pipeline.deps.db;
  if (call.callerUserId === null || db === undefined) {
    await release(pipeline, call, RELEASE_CODE_FORBIDDEN, 'failed');
    return;
  }
  await db
    .updateTable('users')
    .set({ dnd: dnd ? 1 : 0 })
    .where('id', '=', call.callerUserId)
    .execute();
  // Core's own cross-write (§3.1) reaches no `/internal/configChanged`; `refreshUser` derives the
  // hint and status from the config snapshot, so it must reload after this write.
  pipeline.deps.cache.invalidate();
  await presence.refreshUser(call.callerUserId);
  await concludeFeature(pipeline, call, 'answered');
}

/** `*97<ext>`: deposits the caller in `ext`'s mailbox without ringing (§9.3), through Task 28's
 * real `deposit()`. */
async function depositFeature(
  pipeline: Pipeline,
  call: Call,
  ext: string
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const owner = ownerForExt(snapshot, ext);
  if (owner === null) {
    await release(pipeline, call, RELEASE_CODE_NOT_FOUND, 'failed');
    return;
  }
  await deposit(pipeline, call, owner);
}

/** Dispatches one feature-code dial (§9.3 table); unimplemented and unreachable keys share one refusal. */
export async function handleFeature(
  pipeline: Pipeline,
  presence: Presence,
  call: Call,
  key: FeatureCodeKey,
  rest: string
): Promise<void> {
  const actions: Partial<Record<FeatureCodeKey, () => Promise<void>>> = {
    pickup: () => pickup(pipeline, call, rest),
    dndOn: () => setDnd(pipeline, presence, call, true),
    dndOff: () => setDnd(pipeline, presence, call, false),
    mailbox: () => mailboxAccess(pipeline, call, rest),
    ownVoicemail: () => ownVoicemail(pipeline, call),
    deposit: () => depositFeature(pipeline, call, rest),
    addParty: () => addParty(pipeline, call, rest),
    park: () => park(pipeline, presence, call)
  };
  const action = actions[key];
  if (action === undefined) {
    await release(pipeline, call, RELEASE_CODE_NOT_FOUND, 'failed');
    return;
  }
  await action();
}
