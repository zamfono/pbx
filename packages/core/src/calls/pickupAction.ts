/**
 * `POST /internal/calls/{id}/pickup` (§10.1 "Pickup" over the API): rings the picker's own phones
 * as any user's ring does (`ownDevices.ts`), and the one that answers takes the call the request
 * names, the way `*8<ext>` takes the call it finds (`pickup.ts`). `pickup`'s own trace line on
 * that call names the actor.
 */
import { newId, type PickupRequest } from '@zamfono/shared';

import { ignoreGone, logFailure } from '../ari/failures.js';
import type { Snapshot } from '../internal/snapshot.js';
import { RelayedCallLog } from '../relayedCallLog.js';
import { ActionError, HTTP_CONFLICT } from './actionError.js';
import { callLogMaxBytesFromEnv, newCall, type Call } from './call.js';
import { extensionOf } from './extensionOwner.js';
import { ringOwnDevices, ringTimeoutOf } from './ownDevices.js';
import { pickUp, pickupRingOf } from './pickup.js';
import type { Pipeline } from './pipeline.js';
import { registeredDevices } from './userDevices.js';

/** The extension `call` is ringing right now, `null` once it stopped (§10.1 "Pickup"). */
function ringingExtension(
  pipeline: Pipeline,
  snapshot: Snapshot,
  call: Call
): string | null {
  const ringing = pickupRingOf(pipeline, call);
  return ringing === null ? null : extensionOf(snapshot, ringing.rings);
}

/** The answered phone takes `target`, if it still rings; else the phone is hung up, and
 * `target`'s trace says the pickup found it no longer ringing. */
async function takeOnAnswer(
  pipeline: Pipeline,
  target: Call,
  userId: string,
  channelId: string
): Promise<void> {
  const ringing = pickupRingOf(pipeline, target);
  if (
    ringing !== null &&
    (await pickUp(pipeline, target, ringing.ring, { channelId, userId }))
  ) {
    return;
  }
  target.log.event({ event: 'pickup', userId, result: 'notRinging' });
  await pipeline.deps.ari.channels.hangup(channelId).catch(ignoreGone);
}

/** `req.userId` picks up `target`: 409 `notRinging` for a call that rings nobody, 409
 * `noRegisteredDevice` for a picker without a registered phone. */
export async function pickupOnRequest(
  pipeline: Pipeline,
  target: Call,
  req: PickupRequest
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const ext = ringingExtension(pipeline, snapshot, target);
  if (ext === null) {
    throw new ActionError(HTTP_CONFLICT, 'notRinging', 'call is not ringing');
  }
  const devices = registeredDevices(pipeline, snapshot, req.userId);
  if (devices.length === 0) {
    throw new ActionError(
      HTTP_CONFLICT,
      'noRegisteredDevice',
      'no registered device'
    );
  }
  target.log.event({
    event: 'pickup',
    userId: req.userId,
    actorUserId: req.actorUserId,
    ext
  });
  // The ring's own race, on a call of its own that is never written: the answered phone becomes
  // `target`'s answering leg. Its trace (the devices rung, declined or never placed) lands in
  // `target`'s own, so a pickup that failed is explained in the history of the call it was for
  // (§7 "every REST live-call action").
  const host = newCall({
    id: newId(),
    direction: 'internal',
    callerChannelId: null,
    from: target.from,
    to: ext,
    startedAt: pipeline.deps.now(),
    logLevel: target.log.level,
    callLogMaxBytes: callLogMaxBytesFromEnv()
  });
  host.log = new RelayedCallLog(
    host.id,
    target.log,
    'pickupRing',
    callLogMaxBytesFromEnv()
  );
  const ring = ringOwnDevices(pipeline, {
    host,
    // §7 level `sip`: each device's dialog rings for the picked-up call and, answered, becomes
    // its leg, so it is joined to that call's SIP log as a ring race's legs are.
    sipCall: target,
    userId: req.userId,
    devices,
    callerId: target.from,
    timeoutS: ringTimeoutOf(snapshot, req.userId),
    language: snapshot.settings.language,
    peer: target.from,
    // A key of its own: the answered phone sets the picker in `target`'s call itself.
    presenceKey: `pickup:${target.id}`
  });
  ring.outcome
    .then(async outcome => {
      if (outcome.kind === 'answered') {
        await takeOnAnswer(pipeline, target, req.userId, outcome.channel.id);
      } else if (outcome.kind === 'unanswered') {
        target.log.event({
          event: 'pickup',
          userId: req.userId,
          result: 'unanswered'
        });
      }
    })
    .catch(logFailure(pipeline.deps.logger, 'pickup', { callId: target.id }));
  await ring.placed;
}
