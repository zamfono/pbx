/**
 * Following a SIP `REFER` attended transfer (§10.1 "Transfers and pickup"):
 * `BridgeAttendedTransfer` joins the transferee to the transfer target. The core closes the
 * transferrer's participations in both calls; the consultation call continues as the
 * conversation and receives `parent_call_id` set to the original call.
 *
 * Asterisk reports one of two joins. `bridge`: it merged the two bridges into
 * `destination_bridge`. `link`: two bridges the core controls cannot be merged, so Asterisk swaps
 * a Local channel pair in for the transferrer's two channels, one half in each bridge. The core
 * then moves the transferee into the consultation's bridge and ends the pair, so the conversation
 * is one bridge of two parties again and ends like any other when either of them leaves.
 */
import { newId } from '@zamfono/shared';

import type { AriEventOf } from '../ari/events.js';
import { ignoreGone, logFailure } from '../ari/failures.js';
import type { Call, Transferee } from './call.js';
import { otherChannelIn, presentCallerUserId } from './callLookup.js';
import { callPartiesChanged } from './callState.js';
import { endHold } from './hold.js';
import { closeCall } from './liveCall.js';
import { transfereeOf, userOfChannel } from './onwardCall.js';
import type { Pipeline } from './pipeline.js';

type AttendedTransfer = AriEventOf<'BridgeAttendedTransfer'>;

/**
 * The consultation carries on without the transferrer's `secondLeg` and with the transferee in
 * its place (§10.1): their channel takes the one the transferrer held, as the call's caller or as
 * an answered leg, so the transferee leaving ends the conversation the way that side's leaving
 * always does. Synchronous, so no event for either channel falls between the two. Shared with
 * the attended transfer `api` requests (`consultation.ts`), whose consultation has no caller
 * channel (`secondLeg` `null`): the transferee takes that empty caller place.
 */
export function handOver(
  pipeline: Pipeline,
  consultation: Call,
  secondLeg: string | null,
  transferee: Transferee
): void {
  const { recorder, presence } = pipeline.deps;
  const transferrerUserId =
    secondLeg === null
      ? presentCallerUserId(consultation)
      : userOfChannel(consultation, secondLeg);
  if (transferrerUserId !== null) {
    presence.setCallState(
      transferrerUserId,
      'idle',
      null,
      null,
      consultation.id
    );
  }
  if (secondLeg !== null) {
    pipeline.callByChannel.delete(secondLeg);
  }
  pipeline.callByChannel.set(transferee.channelId, consultation);
  // §10.2: the transferrer's recorded participation in this row ends here, not with the row.
  if (secondLeg === null || secondLeg === consultation.callerChannelId) {
    recorder.onCallerEnded(consultation).catch(
      logFailure(pipeline.deps.logger, 'transferrer recording stop', {
        callId: consultation.id
      })
    );
    consultation.callerChannelId = transferee.channelId;
    consultation.callerLegId = newId();
    consultation.callerChannelUserId = transferee.userId;
    if (transferee.targetRecords === undefined) {
      delete consultation.callerTargetRecords;
    } else {
      consultation.callerTargetRecords = transferee.targetRecords;
    }
    pipeline.registerCall(consultation);
    callPartiesChanged(pipeline.deps, consultation);
    return;
  }
  const leg = consultation.legs.get(secondLeg);
  if (leg !== undefined) {
    recorder.onLegEnded(consultation, leg).catch(
      logFailure(pipeline.deps.logger, 'transferrer recording stop', {
        callId: consultation.id
      })
    );
    leg.state = 'ended';
  }
  consultation.legs.set(transferee.channelId, {
    id: newId(),
    channelId: transferee.channelId,
    kind: 'device',
    userId: transferee.userId,
    state: 'up',
    endCause: null,
    ...(transferee.targetRecords === undefined
      ? {}
      : { targetRecords: transferee.targetRecords })
  });
  callPartiesChanged(pipeline.deps, consultation);
}

/** A `link` join: the transferee moves into the consultation's bridge and the Local pair ends. */
async function collapseLink(
  pipeline: Pipeline,
  ev: AttendedTransfer,
  transfereeId: string,
  consultationBridgeId: string
): Promise<void> {
  const { ari } = pipeline.deps;
  const firstBridge = ev.transferer_first_leg_bridge?.id;
  if (firstBridge !== undefined) {
    await ari.bridges
      .removeChannel(firstBridge, transfereeId)
      .catch(ignoreGone);
  }
  await ari.bridges
    .addChannel(consultationBridgeId, transfereeId)
    .catch(ignoreGone);
  const halves = [
    ev.destination_link_first_leg,
    ev.destination_link_second_leg
  ].flatMap(half => (half === undefined ? [] : [half.id]));
  await Promise.all(
    halves.map(id => ari.channels.hangup(id).catch(ignoreGone))
  );
  if (firstBridge !== undefined) {
    await ari.bridges.destroy(firstBridge).catch(ignoreGone);
  }
}

/** The consultation's own side of the transfer: its parent, the hand-over and its bridge. */
async function carryOn(
  pipeline: Pipeline,
  ev: AttendedTransfer,
  consultation: Call,
  parent: { call: Call; secondLeg: string; transfereeId: string }
): Promise<void> {
  const { call: original, secondLeg, transfereeId } = parent;
  consultation.parentCallId = original.id;
  const transferee = transfereeOf(original, transfereeId);
  handOver(pipeline, consultation, secondLeg, transferee);
  if (ev.destination_type === 'bridge' && ev.destination_bridge !== undefined) {
    consultation.bridgeId = ev.destination_bridge;
  }
  if (ev.destination_type === 'link' && consultation.bridgeId !== null) {
    await collapseLink(pipeline, ev, transfereeId, consultation.bridgeId);
  }
  // §10.1 "Recordings follow the participation rule (§10.2) per row": the transferee's
  // participation in the consultation is its own, starting now that it is in that bridge.
  await pipeline.deps.recorder.onTransfereeUp(consultation, transferee).catch(
    logFailure(pipeline.deps.logger, 'transferee recording', {
      callId: consultation.id
    })
  );
}

/** `BridgeAttendedTransfer` (§10.1 "Transfers and pickup"), as the file comment describes. */
export async function onAttendedTransfer(
  pipeline: Pipeline,
  ev: AttendedTransfer
): Promise<void> {
  const first = ev.transferer_first_leg;
  const second = ev.transferer_second_leg;
  const original = pipeline.callByChannel.get(first.id);
  const consultation = pipeline.callByChannel.get(second.id);
  original?.log.event({ event: 'attendedTransfer', result: ev.result });
  consultation?.log.event({
    event: 'attendedTransfer',
    result: ev.result,
    parentCallId: original?.id ?? null
  });
  if (ev.result !== 'Success' || original === undefined) {
    return;
  }
  const transfereeId = ev.transferee?.id ?? otherChannelIn(original, first.id);
  if (consultation !== undefined && transfereeId !== null) {
    const heldIn = original.bridgeId;
    await carryOn(pipeline, ev, consultation, {
      call: original,
      secondLeg: second.id,
      transfereeId
    });
    // A transferee held through the API (`hold.ts`) is in neither bridge Asterisk joined.
    await endHold(pipeline, heldIn, consultation.bridgeId);
  }
  // The transferrer's first channel is left with nobody; Asterisk ends the second itself.
  await closeCall(pipeline, original, 'answered', [first.id]);
}
