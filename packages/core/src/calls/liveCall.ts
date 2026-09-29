/**
 * One of the two primitives the live-call actions of §3 are made of, shared by `actions.ts` and
 * `transfers.ts`: `closeCall` ends a `Call`'s bookkeeping and writes its history entry (a hangup
 * over the API, a transferrer leaving). The other, sending a channel through the dial
 * resolution, is `routeToTarget.ts`'s.
 */
import type { Call, CallsRow } from './call.js';
import { traceSystemEnd } from './callEnd.js';
import { clearFindMeTimers } from './legs.js';
import { notifyMissedCall } from './missedCall.js';
import type { Pipeline } from './pipeline.js';
import { stopGroupRinging } from './ringGroupDial.js';

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
 * Ends `call`'s bookkeeping (§10.1 "Call aggregate"): stops its ring race and timers, unmaps its
 * channels, returns its participants to idle (§9.3), ends every recorded participation in it
 * (§10.2 "Recording semantics") and writes its history entry (§10.2 "Call history") under the
 * status it already reached, else `status`, sending the missed-call mail for a call it ends as
 * missed. With `hangupChannels` every channel still live is hung up and the bridge destroyed;
 * without, they stay up for whoever now carries them (a transfer's transferee, a bridge Asterisk
 * merged). A caller in a voicemail deposit is only hung up, the deposit closing its row.
 */
export async function closeCall(
  pipeline: Pipeline,
  call: Call,
  status: CallsRow['status'],
  hangupChannels: boolean
): Promise<void> {
  // §7: the RTP statistics are read while the channels still exist, and before the legs below
  // stop counting as up.
  await pipeline.deps.cdr.captureQos?.(call);
  traceSystemEnd(call);
  if (call.depositing === true) {
    // §10.2 "Voicemail": a caller in a mailbox deposit is hung up like one ending the message
    // themselves, and the deposit closes the row once the recording's outcome follows.
    await pipeline.deps.ari.channels
      .hangup(call.callerChannelId)
      .catch(() => undefined);
    return;
  }
  const pending = pipeline.pendingRing.get(call.id);
  if (pending !== undefined) {
    clearTimeout(pending.timer);
    pipeline.pendingRing.delete(call.id);
  }
  clearFindMeTimers(pipeline, call.id);
  stopGroupRinging(pipeline, call, null);
  const live = [call.callerChannelId];
  const upLegs = [...call.legs.values()].filter(leg => leg.state === 'up');
  for (const leg of call.legs.values()) {
    if (leg.state !== 'ended') {
      live.push(leg.channelId);
    }
    leg.state = 'ended';
  }
  for (const channelId of [call.callerChannelId, ...call.legs.keys()]) {
    if (pipeline.callByChannel.get(channelId) === call) {
      pipeline.callByChannel.delete(channelId);
    }
  }
  for (const userId of participants(call)) {
    pipeline.deps.presence?.setCallState(userId, 'idle', null, null, call.id);
  }
  // §10.2 "Mail": a call this ends unanswered, still ringing, is missed like any other.
  const missed = call.status === null && status === 'missed';
  call.status ??= status;
  if (missed) {
    await notifyMissedCall(pipeline, call);
  }
  const { ari, recorder } = pipeline.deps;
  // §10.2: each recorded participation is stopped while its channel is still up, then mixed and
  // stored; nothing else ends it once the channels are no longer this call's.
  const recordings = Promise.all([
    recorder?.onCallerEnded(call),
    ...upLegs.map(leg => recorder?.onLegEnded(call, leg))
  ]).catch(() => undefined);
  if (hangupChannels) {
    await Promise.all(
      live.map(channelId =>
        ari.channels.hangup(channelId).catch(() => undefined)
      )
    );
    if (call.bridgeId !== null) {
      await ari.bridges.destroy(call.bridgeId).catch(() => undefined);
    }
  }
  await recordings;
  await pipeline.deps.cdr.finish(call);
  pending?.resolve('abandoned');
}
