/**
 * The end of a call's legs (§10.1 step 4 "Call aggregate"): a leg or the caller's own channel
 * ending. A ring race concluding without an answer is `ringConclusion.ts`'s.
 */
import type { AriEventOf } from '../ari/events.js';
import { logFailure, logUnlessGone } from '../ari/failures.js';
import type { Call } from './call.js';
import { traceChannelEnded } from './callEnd.js';
import { clearFindMeTimers } from './findMe.js';
import { endHold, holdIn } from './hold.js';
import { endLeg, hangupLeg } from './legs.js';
import { finishAbandoned } from './missedCall.js';
import { releaseParkedChannel } from './parking.js';
import type { Pipeline } from './pipeline.js';
import { endRingingLeg } from './ringConclusion.js';

// The fewest parties a bridge still carries a conversation between.
const CONVERSATION_PARTIES = 2;

/** Every user who took part in `call` (§9.3, §10.2 "Presence and BLF"): its legs' own owners plus
 * whoever answered it, deduplicated — a direct ring, a ring-group win or a pickup's target all
 * resolve through this the same way. */
function participantsOf(call: Call): Set<string> {
  const userIds = new Set<string>();
  for (const leg of call.legs.values()) {
    if (leg.userId !== null) {
      userIds.add(leg.userId);
    }
  }
  if (call.answeredByUserId !== null) {
    userIds.add(call.answeredByUserId);
  }
  if (call.callerUserId !== null) {
    userIds.add(call.callerUserId);
  }
  return userIds;
}

/** Drops every participant's presence for `call` back to idle (§9.3 "a user: ... NOT_INUSE";
 * §10.2 "Presence and BLF"). A no-op per user for a call that never set their flags in the first
 * place (`Presence.setCallState`'s own idle is a no-op on an absent entry), so this is safe to
 * call from both the caller's own channel ending and an answered leg's. */
function clearParticipantPresence(pipeline: Pipeline, call: Call): void {
  for (const userId of participantsOf(call)) {
    pipeline.deps.presence.setCallState(userId, 'idle', null, null, call.id);
  }
}

/**
 * A party left `call`'s bridge (§10.1 "Call aggregate"). A bridge the core created outlives its
 * channels: Asterisk hangs up nobody when one side of a Stasis bridge goes, so the other side
 * would sit in it, and in Stasis, until its own party hung up. Once fewer than two parties remain
 * the rest are hung up and the bridge destroyed; a bridge still holding two or more — a three-way
 * call's added leg leaving (§10.2 "Three-way calls": "leaves the original two-party call intact")
 * — carries on, unless the party leaving is the three-way call's initiator: "the initiator
 * hanging up ends the bridge for everyone". A party held out of the bridge (`hold.ts`) is
 * still one of them, and the one who held it leaving ends it like an initiator. `leavingChannelId`
 * is filtered out, since its departure may not have reached the bridge's own membership yet.
 */
async function releaseLastParty(
  pipeline: Pipeline,
  call: Call,
  leavingChannelId: string
): Promise<void> {
  if (call.bridgeId === null) {
    return;
  }
  const { ari } = pipeline.deps;
  const bridges =
    (await ari.bridges
      .list()
      .catch(
        logFailure(pipeline.deps.logger, 'bridge list', { callId: call.id })
      )) ?? [];
  const bridge = bridges.find(candidate => candidate.id === call.bridgeId);
  if (bridge === undefined) {
    return;
  }
  const hold = holdIn(pipeline, bridge.id);
  if (hold?.channelId === leavingChannelId) {
    await endHold(pipeline, bridge.id, null);
  }
  const held =
    hold === null || hold.channelId === leavingChannelId
      ? []
      : [hold.channelId];
  const remaining = [
    ...bridge.channels.filter(id => id !== leavingChannelId),
    ...held
  ];
  const initiatorLeft =
    call.threeWayInitiatorChannelId === leavingChannelId ||
    hold?.byChannelId === leavingChannelId;
  if (remaining.length >= CONVERSATION_PARTIES && !initiatorLeft) {
    return;
  }
  await endHold(pipeline, bridge.id, null);
  await Promise.all(
    remaining.map(channelId =>
      ari.channels.hangup(channelId).catch(
        logUnlessGone(pipeline.deps.logger, 'party hangup', {
          callId: call.id
        })
      )
    )
  );
  await ari.bridges
    .destroy(bridge.id)
    .catch(
      logUnlessGone(pipeline.deps.logger, 'bridge destroy', { callId: call.id })
    );
}

/**
 * The caller's own channel ended, which ends the call whatever state it reached (§10.1 step 4):
 * still ringing, in which case it is missed, or answered, in which case the outcome is already
 * decided. Either way every leg leaves `callByChannel` and the `calls` row is closed out, here or
 * by the voicemail deposit the caller is in — `open()`'s placeholder is the only thing written
 * until `finish()` runs, and a leg left `up` keeps reporting its user as already in a call to
 * every later ring group (§10.1 step 5).
 */
async function endCallerCall(
  pipeline: Pipeline,
  call: Call,
  callerChannelId: string
): Promise<void> {
  call.callerEnded = true;
  const pending = pipeline.pendingRing.get(call.id);
  if (pending) {
    clearTimeout(pending.timer);
    pipeline.pendingRing.delete(call.id);
  }
  clearFindMeTimers(pipeline, call.id);
  pipeline.callByChannel.delete(callerChannelId);
  const hangups: Promise<void>[] = [];
  const recordings: Promise<void>[] = [];
  for (const leg of call.legs.values()) {
    if (leg.state === 'ringing') {
      hangups.push(hangupLeg(pipeline, leg));
    } else if (leg.state === 'up') {
      // §10.2 "Recording semantics": the answered party leaves the bridge with the caller, which
      // ends its participation. Started before `releaseLastParty` hangs its channel up — whose
      // `ChannelDestroyed` no longer reaches this call — so its snoops are stopped while the
      // channel is still up, then mixed and stored, as `closeCall` does (`liveCall.ts`).
      recordings.push(
        pipeline.deps.recorder.onLegEnded(call, leg).catch(
          logFailure(pipeline.deps.logger, 'recording stop', {
            callId: call.id
          })
        )
      );
      // Answered: `releaseLastParty` below hangs up the other side of the bridge. A leg left `up`
      // reports its user as already in a call for the process's lifetime, and `skip_busy` then
      // skips that member in every later ring group.
      endLeg(pipeline, leg.channelId, leg);
    }
  }
  await Promise.all(hangups);
  await releaseLastParty(pipeline, call, callerChannelId);
  await Promise.all(recordings);
  // §10.2 "Voicemail": a caller in a mailbox deposit ends the message by hanging up, and the
  // recording's outcome arrives only after the channel has gone; the deposit closes the row once
  // it knows whether a message was left (`voicemail.ts`'s `deposit`).
  if (call.depositing !== true) {
    await finishAbandoned(pipeline, call);
  }
  // The caller's own channel ending closes out the call either way: still ringing (abandoned) or
  // already answered, in which case `winLeg` set this call's participants `inCall` and nothing
  // else has cleared it since.
  clearParticipantPresence(pipeline, call);
  pending?.resolve('abandoned');
}

/** A leg's `ChannelDestroyed` ends the ring race once none is still ringing; the caller's own channel ending abandons the call (§10.1 step 4). */
export async function handleChannelEnded(
  pipeline: Pipeline,
  ev: AriEventOf<'ChannelDestroyed' | 'StasisEnd'>
): Promise<void> {
  const channelId = ev.channel.id;
  // The parked party's own channel ending while waiting releases its slot and hint (§9.3 "a
  // parking slot: INUSE while a call is parked there"); this call aggregate's own cleanup below
  // still runs exactly as it would for any other ended channel.
  if (ev.type === 'ChannelDestroyed') {
    releaseParkedChannel(pipeline, channelId, pipeline.deps.presence);
  }
  const call = pipeline.callByChannel.get(channelId);
  if (call === undefined) {
    return;
  }
  if (ev.type === 'ChannelDestroyed') {
    traceChannelEnded(call, ev);
  }
  if (channelId === call.callerChannelId) {
    // Only `ChannelDestroyed` ends the caller: a channel leaving Stasis need not be gone, and an
    // attended transfer takes the transferrer's channel out (`StasisEnd`) before Asterisk reports
    // the `BridgeAttendedTransfer` that hands their place to the transferee (§10.1).
    if (ev.type !== 'ChannelDestroyed') {
      return;
    }
    // §10.2: the caller's own participation is mixed and stored when their channel goes, whether
    // the call was answered or abandoned; the recorder ignores a channel it never recorded.
    await pipeline.deps.recorder.onCallerEnded(call);
    await endCallerCall(pipeline, call, channelId);
    return;
  }
  const leg = call.legs.get(channelId);
  // An answered leg's own channel ending closes out the call from that side (§9.3, §10.2
  // "Presence and BLF") the same way the caller's own channel ending does above; a `StasisEnd`
  // for it carries no new information over the `ChannelDestroyed` that always follows.
  if (leg?.state === 'up' && ev.type === 'ChannelDestroyed') {
    clearParticipantPresence(pipeline, call);
    // §10.2: an answered leg leaving the bridge ends its participation's recording and mixes it.
    await pipeline.deps.recorder.onLegEnded(call, leg);
    endLeg(pipeline, channelId, leg);
    // The callee hanging up ends a two-party call for the caller too; the caller's own channel
    // ending then closes the call out above.
    await releaseLastParty(pipeline, call, channelId);
    // §10.2 "Three-way calls": the added leg's own row ends as the added party leaves. A call
    // whose caller already left it (a caller who parked the other party, §10.2 "Call parking")
    // has no caller channel left to end it, so its row ends with the conversation it left.
    if (call.addedLeg === true || call.callerEnded === true) {
      await pipeline.finishCall(call);
    }
    return;
  }
  // StasisEnd precedes ChannelDestroyed for a Stasis channel and carries no cause, so only ChannelDestroyed ends a ringing leg (its Q.850 cause is what ringOutcome() needs).
  // A leg still `placing` never rang: its end is its placement's failure (`legOriginate.ts`).
  if (leg?.state !== 'ringing' || ev.type === 'StasisEnd') {
    return;
  }
  // A find-me leg is an external leg, whose attempt's own end falls through to its next route or
  // ends the leg (`externalAttempt.ts`, §9.4 "Route fallthrough").
  if (leg.kind === 'findMe') {
    return;
  }
  endRingingLeg(pipeline, call, leg, ev.cause);
}
