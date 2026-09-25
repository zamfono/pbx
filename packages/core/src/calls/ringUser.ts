// The start of a user's ring race (§10.1 step 4): originating their devices and scheduling their
// find-me legs, then, once the race ends without an answer, the busy or noAnswer outcome. The race
// itself — the first accepted answer winning, a leg ending early — is `legs.ts`'s.

import { channelLanguageVariable } from '../prompts.js';
import { takeJoinBridge } from './bridgeJoin.js';
import { release, type Call } from './call.js';
import { callRinging } from './callState.js';
import { softphoneCallerId } from './contactName.js';
import { recordEvents, redeliverEarlyEvents } from './earlyEvents.js';
import { scheduleFindMeLegs } from './findMe.js';
import { hangupLeg, trackLeg, type RingOutcome } from './legs.js';
import type { Pipeline } from './pipeline.js';
import { concludeRing } from './ringConclusion.js';
import { devicesToRing, registeredDevices } from './userDevices.js';
import { applyRingOutcome } from './userStep.js';

const MILLISECONDS_PER_SECOND = 1000;
const RELEASE_CODE_UNAVAILABLE = 480;

/** Originates one leg per device of `userId`'s, each tracked on `call` as a ringing device leg. */
async function ringDevices(
  pipeline: Pipeline,
  call: Call,
  userId: string,
  devices: readonly { sipUsername: string }[],
  language: string
): Promise<void> {
  // §10.2 "Phone book": the contact's display name is the caller-ID name on the device legs.
  const callerId = await softphoneCallerId(pipeline, call);
  for (const device of devices) {
    const early = recordEvents(pipeline.deps.ari);
    // eslint-disable-next-line no-await-in-loop -- devices are originated one at a time; a user has at most a handful
    const channel = await pipeline.deps.ari.channels
      .originate({
        endpoint: `PJSIP/${device.sipUsername}`,
        app: 'zamfono',
        appArgs: `leg,${call.id}`,
        callerId,
        // §9.1 "every channel's language": a device leg has been through no entry of its own.
        variables: channelLanguageVariable(language)
      })
      .finally(early.stop);
    pipeline.deps.cdr.registerLeg?.(call, channel.id);
    trackLeg(pipeline, call, {
      channelId: channel.id,
      kind: 'device',
      userId,
      state: 'ringing',
      endCause: null
    });
    call.log.event({ event: 'rungDevice', channelId: channel.id, userId });
    // A phone that declined at once (486, 603) ended before it was tracked (§10.1 step 4).
    redeliverEarlyEvents(pipeline.deps.ari, early, channel.id);
    // --- Task 31 --- (§10.1 step 4: a win landing during this originate must not leave its leg ringing)
    const leg = call.legs.get(channel.id);
    if (call.answeredAt !== null && leg?.state === 'ringing') {
      // eslint-disable-next-line no-await-in-loop -- see above
      await hangupLeg(pipeline, leg);
    }
    // --- end Task 31 ---
  }
}

/**
 * Step 4: originate every registered device (+ find-me legs), first answer wins (§10.1).
 * `existingBridgeId` makes the win join that bridge rather than a fresh one; a caller reaching
 * this ring through `runUserStep` hands the bridge over through `bridgeJoin.ts`'s registry.
 */
export async function ringUser(
  pipeline: Pipeline,
  call: Call,
  userId: string,
  existingBridgeId: string | null = null
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const user = snapshot.users.find(row => row.id === userId);
  if (user === undefined) {
    await release(pipeline, call, RELEASE_CODE_UNAVAILABLE, 'failed');
    return;
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
    await applyRingOutcome(pipeline, call, snapshot, user, 'busy');
    return;
  }
  // pendingRing is set before any originate, so a delayS-0 find-me leg's guard never races it.
  const { promise: outcomePromise, resolve: resolveOutcome } =
    Promise.withResolvers<RingOutcome>();
  const timer = setTimeout(() => {
    concludeRing(pipeline, call);
  }, user.ringTimeoutS * MILLISECONDS_PER_SECOND);
  timer.unref();
  pipeline.pendingRing.set(call.id, {
    resolve: resolveOutcome,
    timer,
    // --- Task 31 ---
    existingBridgeId: existingBridgeId ?? takeJoinBridge(pipeline, call.id)
    // --- end Task 31 ---
  });
  // --- Task 31 --- (§9.3 "a user: RINGING while any of their devices rings")
  pipeline.deps.presence?.setCallState(
    userId,
    'ringing',
    call.from,
    null,
    call.id
  );
  // --- end Task 31 ---

  await ringDevices(
    pipeline,
    call,
    userId,
    devices,
    snapshot.settings.language
  );
  callRinging(pipeline.deps, call);
  scheduleFindMeLegs(pipeline, call, userId, user.findMe ?? []);
  await pipeline.deps.ari.channels
    .ring(call.callerChannelId)
    .catch(() => undefined);

  const outcome = await outcomePromise;
  if (outcome === 'answered') {
    return;
  }
  // --- Task 31 ---
  // Ringing stopped for `userId` either way (abandoned, busy or no answer); `winLeg` sets
  // `inCall` on the answered path instead (§9.3, §10.2 "Presence and BLF").
  pipeline.deps.presence?.setCallState(userId, 'idle', null, null, call.id);
  // --- end Task 31 ---
  if (outcome === 'abandoned') {
    return;
  }
  await applyRingOutcome(pipeline, call, snapshot, user, outcome);
}
