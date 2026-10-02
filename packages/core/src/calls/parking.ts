/** `*70` and call parking (§10.2 "Call parking"): the park and its slot registry, its own module
 * keeping `features.ts` under the repository's `max-lines` lint rule; retrieval is
 * `parkingRetrieval.ts` and the timeout ring-back `parkingRingback.ts`. Its DTMF-menu siblings
 * `mailbox.ts` and `voicemail.ts`'s `deposit` share this file's own suite, `features.test.ts`,
 * rather than one `*.test.ts` each. */
import { MS_PER_SECOND } from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';
import type { Presence } from '../presence.js';
import { callerChannel, release, type Call } from './call.js';
import { activeCallOf, bridgedParty, channelOf } from './callLookup.js';
import { callPartiesChanged } from './callState.js';
import {
  concludeFeature,
  RELEASE_CODE_FORBIDDEN,
  RELEASE_CODE_UNAVAILABLE
} from './featureCall.js';
import { moveParkedParty, ringParkerBack } from './parkingRingback.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';

export type ParkedEntry = {
  call: Call;
  parkerUserId: string;
  // The counterpart's own channel, alone in the holding bridge for the duration of the park (§10.2).
  partyChannelId: string;
  parkedAt: string;
  timer: ReturnType<typeof setTimeout>;
};
/** Frees the slot `channelId` (a parked party's own channel) occupies, if any, when that channel
 * ends on its own (the parked party hanging up while waiting): clears its timer, removes it from
 * the `Pipeline`'s `parkingSlots` and reverts its BLF hint to `NOT_INUSE` (§9.3 "a parking slot:
 * INUSE while a call is parked there"). A no-op, returning `false`, for a channel that is not a
 * parked party's — every other ended channel `legsEnded.ts` calls this for. */
export function releaseParkedChannel(
  pipeline: Pipeline,
  channelId: string,
  presence: Presence | null
): boolean {
  const byChannel = pipeline.parkedSlotByChannel;
  const ext = byChannel.get(channelId);
  if (ext === undefined) {
    return false;
  }
  byChannel.delete(channelId);
  const slots = pipeline.parkingSlots;
  const entry = slots.get(ext);
  if (entry !== undefined) {
    clearTimeout(entry.timer);
    slots.delete(ext);
  }
  presence?.setHint(ext, 'NOT_INUSE').catch(() => undefined);
  return true;
}

/** The lowest parking slot no call occupies (§10.2 "Call parking"), `null` when every slot is taken. */
function lowestFreeSlot(
  snapshot: Snapshot,
  slots: ReadonlyMap<string, ParkedEntry>
): string | null {
  return (
    snapshot.extensions
      .filter(row => row.isParkingSlot === 1)
      .map(row => row.ext)
      .sort()
      .find(candidate => !slots.has(candidate)) ?? null
  );
}

/** Takes the parker out of `active`: their channel never re-enters this call (retrieval and the
 * ring-back each dial a fresh one), so it is hung up here. It leaves `callByChannel` first, so
 * its `ChannelDestroyed` is never mistaken for the call abandoning (`legsEnded.ts`'s
 * `endCallerCall`, keyed off `call.callerChannelId`); a leg entry is marked `ended` directly, and
 * the parker's own presence for this call ends here (§9.3 "a user: ... INUSE in a call" —
 * parked, they are in none), as does their recorded participation. A parker who was the call's
 * caller leaves it with its caller gone (`call.callerEnded`), so the parked party's own end, or
 * that of whoever retrieves them, closes the row (`legsEnded.ts`). */
async function dropParker(
  pipeline: Pipeline,
  presence: Presence,
  active: Call,
  parkerUserId: string,
  parkerChannelId: string
): Promise<void> {
  const parkerLeg = active.legs.get(parkerChannelId);
  // §10.2 "Recording semantics": the parker's participation ends as they leave the bridge. Not
  // awaited: mixing waits for Asterisk to finalise the files, which the park need not wait for.
  const { recorder } = pipeline.deps;
  if (parkerChannelId === active.callerChannelId) {
    active.callerEnded = true;
    recorder?.onCallerEnded(active).catch(() => undefined);
  } else if (parkerLeg !== undefined) {
    recorder?.onLegEnded(active, parkerLeg).catch(() => undefined);
    parkerLeg.state = 'ended';
    callPartiesChanged(pipeline.deps, active);
  }
  pipeline.callByChannel.delete(parkerChannelId);
  await pipeline.deps.ari.channels
    .hangup(parkerChannelId)
    .catch(() => undefined);
  presence.setCallState(parkerUserId, 'idle', null, null, active.id);
}

/**
 * Parks `conversation.party`, the other party of `active`'s own conversation (`bridgedParty`),
 * for `parker`, whose channel in it is `parker.channelId`, on the lowest free slot (§10.2 "Call
 * parking"): the party waits in a holding bridge with the hold music, the parker's own channel
 * in the call is hung up, and the parker is rung back on timeout. Shared by `*70` and
 * `POST /internal/calls/{id}/park`, whose `actorUserId` the trace line names. Returns the slot,
 * `null` with every slot taken and nothing moved.
 */
export async function parkParty(
  pipeline: Pipeline,
  presence: Presence,
  active: Call,
  parker: { userId: string; channelId: string; actorUserId?: string },
  conversation: { bridgeId: string; party: string }
): Promise<string | null> {
  const { userId: parkerUserId, channelId: parkerCh } = parker;
  const { bridgeId, party: partyChannelId } = conversation;
  const snapshot = await pipeline.deps.cache.get();
  const slots = pipeline.parkingSlots;
  const ext = lowestFreeSlot(snapshot, slots);
  if (ext === null) {
    return null;
  }
  const ari = pipeline.deps.ari;
  await ari.bridges.removeChannel(bridgeId, parkerCh).catch(() => undefined);
  await dropParker(pipeline, presence, active, parkerUserId, parkerCh);
  await moveParkedParty(pipeline, active, partyChannelId, 'holding');
  // Tenant's own hold music class, falling back to Asterisk's `default` (§10.2 "Call parking",
  // "Hold music"), the same resolution ring groups use for their `moh_audio_id`.
  await ari.channels
    .startMoh(partyChannelId, snapshot.settings.holdMohAudioId ?? undefined)
    .catch(() => undefined);
  const actor =
    parker.actorUserId === undefined ? {} : { actorUserId: parker.actorUserId };
  active.log.event({ event: 'parked', by: parkerUserId, ext, ...actor });
  const timer = setTimeout(() => {
    slots.delete(ext);
    pipeline.parkedSlotByChannel.delete(partyChannelId);
    presence.setHint(ext, 'NOT_INUSE').catch(() => undefined);
    ringParkerBack(pipeline, {
      parkerUserId,
      parked: active,
      partyChannelId
    }).catch(() => undefined);
  }, snapshot.settings.parkingTimeoutS * MS_PER_SECOND);
  timer.unref();
  const parkedAt = pipeline.deps.now();
  slots.set(ext, {
    call: active,
    parkerUserId,
    partyChannelId,
    parkedAt,
    timer
  });
  pipeline.parkedSlotByChannel.set(partyChannelId, ext);
  await presence.setHint(ext, 'INUSE');
  return ext;
}

/** The slot `*70` parks the other party of `userId`'s current call on, `null` when there is
 * nothing to park (no call, or no two-party conversation of its own) or no slot free. */
async function parkActiveCall(
  pipeline: Pipeline,
  presence: Presence,
  userId: string
): Promise<string | null> {
  const active = activeCallOf(pipeline, userId);
  if (active === null) {
    return null;
  }
  const channelId = channelOf(active, userId);
  const conversation =
    channelId === null ? null : bridgedParty(active, channelId);
  if (channelId === null || conversation === null) {
    return null;
  }
  return parkParty(
    pipeline,
    presence,
    active,
    { userId, channelId },
    conversation
  );
}

/** `*70`: parks the other party on the lowest free slot and reads its number to the parker
 * (§10.2). */
export async function park(
  pipeline: Pipeline,
  presence: Presence,
  call: Call
): Promise<void> {
  if (call.callerUserId === null) {
    await release(pipeline, call, RELEASE_CODE_FORBIDDEN, 'failed');
    return;
  }
  const ext = await parkActiveCall(pipeline, presence, call.callerUserId);
  if (ext === null) {
    await release(pipeline, call, RELEASE_CODE_UNAVAILABLE, 'failed');
    return;
  }
  const channelId = callerChannel(call);
  const ari = pipeline.deps.ari;
  await ari.channels.answer(channelId).catch(() => undefined);
  await playAndWait(ari, channelId, `digits:${ext}`, `${channelId}:park`);
  await concludeFeature(pipeline, call, 'answered');
}

/** Takes the call parked at `ext` out of its slot for retrieval (§10.2 "Call parking"): its
 * ring-back timer stops and the slot is free again, its hint reverting to `NOT_INUSE` (§9.3);
 * `null` for an empty slot. */
export async function takeParkedEntry(
  pipeline: Pipeline,
  presence: Presence,
  ext: string
): Promise<ParkedEntry | null> {
  const slots = pipeline.parkingSlots;
  const entry = slots.get(ext);
  if (entry === undefined) {
    return null;
  }
  clearTimeout(entry.timer);
  slots.delete(ext);
  pipeline.parkedSlotByChannel.delete(entry.partyChannelId);
  await presence.setHint(ext, 'NOT_INUSE');
  return entry;
}
