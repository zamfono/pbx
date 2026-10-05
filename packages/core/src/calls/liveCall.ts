/**
 * One of the two primitives the live-call actions of §3 are made of, shared by `actions.ts` and
 * `transfers.ts`: `closeCall` ends a `Call`'s bookkeeping and writes its history entry (a hangup
 * over the API, a transferrer leaving). The other, sending a channel through the dial
 * resolution, is `outboundDispatch.ts`'s.
 */
import { ignoreGone, logFailure, logUnlessGone } from '../ari/failures.js';
import { callerChannel, type Call, type CallsRow } from './call.js';
import { traceSystemEnd } from './callEnd.js';
import { clearFindMeTimers } from './findMe.js';
import { stopGroupRinging } from './groupPickup.js';
import { endHold, holdIn, holdOf } from './hold.js';
import { settleStatus } from './missedCall.js';
import type { Pipeline } from './pipeline.js';

/** Every user who took part in `call`: its caller, its legs' owners and whoever answered it. */
function participants(call: Call): Set<string> {
  const userIds = new Set<string>();
  for (const leg of call.legs.values()) {
    if (leg.userId !== null) {
      userIds.add(leg.userId);
    }
  }
  for (const userId of [call.callerUserId, call.answeredByUserId]) {
    if (userId !== null) {
      userIds.add(userId);
    }
  }
  return userIds;
}

/**
 * Ends the conversation of a call closed with its channels: whoever else is still in its bridge
 * (a party added to it, §10.2 "Three-way calls") or held out of it (`hold.ts`) is hung up, and the
 * bridge destroyed. An added leg's own row shares the bridge of the call it joined, which goes on
 * without it.
 */
async function endConversation(
  pipeline: Pipeline,
  call: Call,
  hungUp: readonly string[]
): Promise<void> {
  const { bridgeId } = call;
  if (bridgeId === null || call.addedLeg === true) {
    return;
  }
  const { ari } = pipeline.deps;
  const held = holdIn(pipeline, bridgeId)?.channelId;
  await endHold(pipeline, bridgeId, null);
  const bridges =
    (await ari.bridges
      .list()
      .catch(
        logFailure(pipeline.deps.logger, 'bridge list', { callId: call.id })
      )) ?? [];
  const inBridge = bridges.find(bridge => bridge.id === bridgeId)?.channels;
  const others = [...(inBridge ?? []), ...(held === undefined ? [] : [held])];
  await Promise.all(
    others
      .filter(channelId => !hungUp.includes(channelId))
      .map(channelId =>
        ari.channels.hangup(channelId).catch(
          logUnlessGone(pipeline.deps.logger, 'party hangup', {
            callId: call.id
          })
        )
      )
  );
  await ari.bridges
    .destroy(bridgeId)
    .catch(
      logUnlessGone(pipeline.deps.logger, 'bridge destroy', { callId: call.id })
    );
}

/** A call closed with its channels left to whoever carries them (a transfer) whose party is still
 * held out of its bridge (`hold.ts`): nothing returns that party to a conversation, so it is hung
 * up rather than left in Stasis with its hold music. */
async function dropStrandedHold(pipeline: Pipeline, call: Call): Promise<void> {
  const hold = holdOf(pipeline, call);
  if (hold === null) {
    return;
  }
  await endHold(pipeline, call.bridgeId, null);
  await pipeline.deps.ari.channels.hangup(hold.channelId).catch(
    logUnlessGone(pipeline.deps.logger, 'held party hangup', {
      callId: call.id
    })
  );
}

/** Hangs up the channels a call closed with the rest of its channels left up is `leaving`. */
async function hangUpLeaving(
  pipeline: Pipeline,
  call: Call,
  leaving: readonly string[]
): Promise<void> {
  await Promise.all(
    leaving.map(channelId =>
      pipeline.deps.ari.channels.hangup(channelId).catch(
        logUnlessGone(pipeline.deps.logger, 'transferrer hangup', {
          callId: call.id
        })
      )
    )
  );
}

/** Hangs up `call`'s `live` channels, the caller's with `callerCause` where one is given, and
 * the rest of its conversation (`endConversation`). */
async function hangUpLive(
  pipeline: Pipeline,
  call: Call,
  live: readonly string[],
  callerCause: number | undefined
): Promise<void> {
  await Promise.all(
    live.map(channelId =>
      pipeline.deps.ari.channels
        .hangup(
          channelId,
          channelId === call.callerChannelId && callerCause !== undefined
            ? { reasonCode: callerCause }
            : undefined
        )
        .catch(
          logUnlessGone(pipeline.deps.logger, 'party hangup', {
            callId: call.id
          })
        )
    )
  );
  await endConversation(pipeline, call, live);
}

/**
 * Ends `call`'s bookkeeping (§10.1 "Call aggregate"): stops its ring race and timers, unmaps its
 * channels, returns its participants to idle (§9.3), ends every recorded participation in it
 * (§10.2 "Recording semantics") and writes its history entry (§10.2 "Call history") under the
 * status it already reached, else `status`, sending the missed-call mail for a call it ends as
 * missed. With `hangup` `'all'` every channel still live is hung up, with the rest of its
 * conversation (`endConversation`), the caller's with the Q.850 `callerCause` where one is given;
 * with a list, only those channels are (a transfer's transferrer, left with nobody), and the rest
 * stay up for whoever now carries them (a transfer's transferee, a bridge Asterisk merged). Either
 * way the hangups go out before the history entry is written, so the messages ending their SIP
 * dialogs are in the call's log (§7 level `sip`). A caller in a voicemail deposit is only hung up,
 * the deposit closing its row.
 */
export async function closeCall(
  pipeline: Pipeline,
  call: Call,
  status: CallsRow['status'],
  hangup: 'all' | readonly string[],
  callerCause?: number
): Promise<void> {
  // §7: the channels whose `call_qos` rows this call has are noted before the legs below stop
  // counting as up.
  pipeline.deps.cdr.noteQosLegs(call);
  traceSystemEnd(call);
  if (call.depositing === true) {
    // §10.2 "Voicemail": a caller in a mailbox deposit is hung up like one ending the message
    // themselves, and the deposit closes the row once the recording's outcome follows.
    await pipeline.deps.ari.channels
      .hangup(callerChannel(call))
      .catch(ignoreGone);
    return;
  }
  const pending = pipeline.pendingRing.get(call.id);
  if (pending !== undefined) {
    clearTimeout(pending.timer);
    pipeline.pendingRing.delete(call.id);
  }
  clearFindMeTimers(pipeline, call.id);
  stopGroupRinging(pipeline, call, null);
  const own = call.callerChannelId === null ? [] : [call.callerChannelId];
  const live = [...own];
  const upLegs = [...call.legs.values()].filter(leg => leg.state === 'up');
  for (const leg of call.legs.values()) {
    // A leg still `placing` is its placement's to settle (`Leg`), its ring being over.
    if (leg.state === 'placing') {
      continue;
    }
    if (leg.state !== 'ended') {
      live.push(leg.channelId);
    }
    leg.state = 'ended';
  }
  for (const channelId of [...own, ...call.legs.keys()]) {
    if (pipeline.callByChannel.get(channelId) === call) {
      pipeline.callByChannel.delete(channelId);
    }
  }
  for (const userId of participants(call)) {
    pipeline.deps.presence.setCallState(userId, 'idle', null, null, call.id);
  }
  // §10.2 "Mail": a call this ends unanswered, still ringing, is missed like any other.
  await settleStatus(pipeline, call, status);
  const { recorder } = pipeline.deps;
  // §10.2: each recorded participation is stopped while its channel is still up, then mixed and
  // stored; nothing else ends it once the channels are no longer this call's.
  const recordings = Promise.all([
    recorder.onCallerEnded(call),
    ...upLegs.map(leg => recorder.onLegEnded(call, leg))
  ]).catch(
    logFailure(pipeline.deps.logger, 'recording stop', { callId: call.id })
  );
  if (hangup === 'all') {
    await hangUpLive(pipeline, call, live, callerCause);
  } else {
    await hangUpLeaving(pipeline, call, hangup);
    await dropStrandedHold(pipeline, call);
  }
  await recordings;
  await pipeline.finishCall(call);
  pending?.resolve('abandoned');
}
