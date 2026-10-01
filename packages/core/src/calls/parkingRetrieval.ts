/**
 * Retrieving a parked call (§10.2 "Call parking": "Dialling the slot from any device takes the
 * call out of the bridge"; §9.3 table), its own module beside `parking.ts`, which owns the slot
 * registry, so both stay under the repository's `max-lines` lint rule.
 */
import type { Presence } from '../presence.js';
import type { Call, Leg } from './call.js';
import { closeFeatureCall } from './featureCall.js';
import { trackLeg } from './legs.js';
import { takeParkedEntry } from './parking.js';
import { moveParkedParty } from './parkingRingback.js';
import type { Pipeline } from './pipeline.js';

/**
 * The retriever's own channel as an answered leg of `parked`, the way pickup folds the picker's
 * channel into the call it takes (`features.ts`): either side hanging up then ends the
 * conversation for the other (`legsEnded.ts`), the retriever is in a call (§9.3 "a user: ...
 * INUSE in a call") and their participation is recorded on its own flags from the moment they
 * enter the bridge (§10.2 "Recording semantics").
 */
async function joinRetriever(
  pipeline: Pipeline,
  parked: Call,
  call: Call
): Promise<void> {
  const leg: Leg = {
    channelId: call.callerChannelId,
    kind: 'device',
    userId: call.callerUserId,
    state: 'up',
    endCause: null
  };
  trackLeg(pipeline, parked, leg);
  if (call.callerUserId !== null) {
    const { presence } = pipeline.deps;
    presence?.setCallState(
      call.callerUserId,
      'inCall',
      parked.from,
      null,
      parked.id
    );
    // The slot dial's own in-call state (`outbound.ts`) is carried by `parked` from here on; the
    // dial's row closes below and its channel no longer ends it.
    presence?.setCallState(call.callerUserId, 'idle', null, null, call.id);
  }
  // §7 level `sip`: the retriever's dialog is the parked call's leg now, not the slot dial's.
  pipeline.deps.cdr.registerLeg?.(parked, call.callerChannelId);
  await pipeline.deps.recorder?.onLegUp(parked, leg);
}

/** Retrieves the call parked at `ext` (§9.3 table) into a mixing bridge shared with the
 * retriever's own channel; `'empty'` cues the short error tone. */
export async function retrieveParkedCall(
  pipeline: Pipeline,
  presence: Presence,
  call: Call,
  ext: string
): Promise<'retrieved' | 'empty'> {
  const entry = await takeParkedEntry(pipeline, presence, ext);
  if (entry === null) {
    return 'empty';
  }
  const parked = entry.call;
  parked.answeredByUserId = call.callerUserId;
  parked.log.event({ event: 'parkingRetrieved', ext, by: call.callerUserId });
  const ari = pipeline.deps.ari;
  await ari.channels.stopMoh(entry.partyChannelId).catch(() => undefined);
  const bridgeId = await moveParkedParty(
    pipeline,
    parked,
    entry.partyChannelId,
    'mixing'
  );
  await ari.channels.answer(call.callerChannelId).catch(() => undefined);
  await ari.bridges
    .addChannel(bridgeId, call.callerChannelId)
    .catch(() => undefined);
  await joinRetriever(pipeline, parked, call);
  // The retriever's own channel now carries the conversation; it stays up (§9.3 table).
  await closeFeatureCall(pipeline, call, 'answered');
  return 'retrieved';
}
