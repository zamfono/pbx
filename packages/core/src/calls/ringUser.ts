// The start of a user's ring race (§10.1 step 4): originating their devices and scheduling their
// find-me legs, then, once the race ends without an answer, the busy or noAnswer outcome. The race
// itself — the first accepted answer winning, a leg ending early — is `legs.ts`'s.

import { MS_PER_SECOND, newId } from '@zamfono/shared';

import { ignoreGone } from '../ari/failures.js';
import { channelLanguageVariable } from '../prompts.js';
import { SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { release, takeJoinBridge, type Call, type Leg } from './call.js';
import { callPartiesChanged, callRinging } from './callState.js';
import { softphoneCallerId } from './contactName.js';
import { findMeLegsPending, scheduleFindMeLegs } from './findMe.js';
import { originateLeg } from './legOriginate.js';
import { hangupLeg, trackLeg, untrackLeg, type RingOutcome } from './legs.js';
import type { Pipeline } from './pipeline.js';
import { concludeRing, placeAll } from './ringConclusion.js';
import { devicesToRing, registeredDevices } from './userDevices.js';
import { applyRingOutcome, type UnappliedDecision } from './userStep.js';

type DeviceRing = {
  userId: string;
  callerId: string;
  language: string;
};

/** Originates one leg for `device`, tracked on `call` as a device leg: placing, then ringing. */
async function ringDevice(
  pipeline: Pipeline,
  call: Call,
  ring: DeviceRing,
  device: { id: string; sipUsername: string }
): Promise<void> {
  const { userId } = ring;
  const leg: Leg = {
    channelId: newId(),
    kind: 'device',
    userId,
    state: 'placing',
    endCause: null,
    deviceId: device.id
  };
  trackLeg(pipeline, call, leg);
  const placed = await originateLeg(
    pipeline,
    call,
    {
      channelId: leg.channelId,
      endpoint: `PJSIP/${device.sipUsername}`,
      app: 'zamfono',
      appArgs: `leg,${call.id}`,
      callerId: ring.callerId,
      // §9.1 "every channel's language": a device leg has been through no entry of its own.
      variables: channelLanguageVariable(ring.language)
    },
    () => {
      leg.state = 'ringing';
      call.log.event({ event: 'rungDevice', channelId: leg.channelId, userId });
    }
  ).then(
    () => true,
    () => false
  );
  if (!placed) {
    // Refused before it rang (`legOriginate.ts`): the device leaves the race as if it declined.
    untrackLeg(pipeline, call, leg);
    call.log.event({
      event: 'rungDevice',
      deviceId: device.id,
      userId,
      cause: 'placementFailed'
    });
    return;
  }
  callPartiesChanged(pipeline.deps, call);
  // §10.1 step 4: a win landing during this originate must not leave its leg ringing,
  // nor must the race ending unanswered meanwhile, its timeout or its last other leg ending.
  const tracked = call.legs.get(leg.channelId);
  const raceOver =
    call.answeredAt !== null || !pipeline.pendingRing.has(call.id);
  if (raceOver && tracked?.state === 'ringing') {
    await hangupLeg(pipeline, tracked);
  }
}

/** Originates one leg per device of `userId`'s, all at once (`placeAll`), each placed in its own
 * order (created, joined, dialled, `legOriginate.ts`). */
async function ringDevices(
  pipeline: Pipeline,
  call: Call,
  userId: string,
  devices: readonly { id: string; sipUsername: string }[],
  language: string
): Promise<void> {
  // §10.2 "Phone book": the contact's display name is the caller-ID name on the device legs.
  const callerId = await softphoneCallerId(pipeline, call);
  const ring: DeviceRing = { userId, callerId, language };
  await placeAll(pipeline, call, devices, device =>
    ringDevice(pipeline, call, ring, device)
  );
}

/**
 * Step 4: originate every registered device (+ find-me legs), first answer wins (§10.1).
 * `existingBridgeId`, else the call's own `joinBridgeId`, makes the win join that bridge rather
 * than a fresh one. Returns the decision `applyRingOutcome` hands back.
 */
export async function ringUser(
  pipeline: Pipeline,
  call: Call,
  userId: string,
  existingBridgeId: string | null = null
): Promise<UnappliedDecision | null> {
  const snapshot = await pipeline.deps.cache.get();
  const user = snapshot.users.find(row => row.id === userId);
  if (user === undefined) {
    await release(pipeline, call, SIP_TEMPORARILY_UNAVAILABLE, 'failed');
    return null;
  }
  // §10.1 step 4 rings the user's registered devices; an unregistered one has nowhere to ring,
  // and the `offline` rule counts the same view (`runUserStep`). A user already in a call is rung
  // on their other devices only.
  const devices = await devicesToRing(pipeline, snapshot, userId);
  if (
    devices.length === 0 &&
    (user.findMe ?? []).length === 0 &&
    registeredDevices(pipeline, snapshot, userId).length > 0
  ) {
    // Every registered device carries a call and is left out of the call waiting, so nothing
    // rings: the core gives the busy answer those devices would have ("Timers, the hop counter
    // and busy handling live entirely in the core") and applies the `busy` rule at once.
    call.log.event({ event: 'ringSkipped', reason: 'everyDeviceInCall' });
    return applyRingOutcome(pipeline, call, snapshot, user, 'busy');
  }
  // pendingRing is set before any originate, so a delayS-0 find-me leg's guard never races it.
  const { promise: outcomePromise, resolve: resolveOutcome } =
    Promise.withResolvers<RingOutcome>();
  const timer = setTimeout(() => {
    concludeRing(pipeline, call);
  }, user.ringTimeoutS * MS_PER_SECOND);
  timer.unref();
  pipeline.pendingRing.set(call.id, {
    resolve: resolveOutcome,
    timer,
    existingBridgeId: existingBridgeId ?? takeJoinBridge(call)
  });
  // §9.3 "a user: RINGING while any of their devices rings".
  pipeline.deps.presence.setCallState(
    userId,
    'ringing',
    call.from,
    null,
    call.id
  );

  await ringDevices(
    pipeline,
    call,
    userId,
    devices,
    snapshot.settings.language
  );
  callRinging(pipeline.deps, call);
  scheduleFindMeLegs(pipeline, call, userId, user.findMe ?? []);
  // Nothing rings nor is still to come (every device refused before it rang, `legOriginate.ts`):
  // the race is over at once, as when the last leg declines.
  const ringing = [...call.legs.values()].some(leg => leg.state === 'ringing');
  if (!ringing && !findMeLegsPending(pipeline, call.id)) {
    concludeRing(pipeline, call);
  }
  if (call.callerChannelId !== null) {
    await pipeline.deps.ari.channels
      .ring(call.callerChannelId)
      .catch(ignoreGone);
  }

  const outcome = await outcomePromise;
  if (outcome === 'answered') {
    return null;
  }
  // Ringing stopped for `userId` either way (abandoned, busy or no answer); `winLeg` sets
  // `inCall` on the answered path instead (§9.3, §10.2 "Presence and BLF").
  pipeline.deps.presence.setCallState(userId, 'idle', null, null, call.id);
  if (outcome === 'abandoned') {
    return null;
  }
  return applyRingOutcome(pipeline, call, snapshot, user, outcome);
}
