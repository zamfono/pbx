/**
 * A live call's legs (§10.3 "Live calls"): the parties in it now, each under the core's own leg
 * id, as `GET /internal/state` and the `call.state` events show them (`callState.ts`), and the
 * leg a live-call action names (`legId`) resolved back to its channel.
 */
import { HTTP_CONFLICT, HTTP_NOT_FOUND, type LiveLeg } from '@zamfono/shared';

import type { StateStore } from '../internal/stateStore.js';
import { ActionError, notBridged } from './actionError.js';
import type { Call, Leg } from './call.js';
import {
  bridgedParty,
  otherChannelIn,
  ownBridge,
  presentCallerUserId,
  transferrerChannel
} from './callLookup.js';
import type { GroupLeg } from './groupLegs.js';
import type { Pipeline } from './pipeline.js';

/** A leg as listed, with the channel it is, which the listing leaves out. */
type ChannelLeg = { leg: LiveLeg; channelId: string };

/** A leg's listed state: `held` while it is the held party, else `up` or `ringing`. */
function stateOf(
  channelId: string,
  heldChannelId: string | undefined,
  up: boolean
): LiveLeg['state'] {
  if (channelId === heldChannelId) {
    return 'held';
  }
  return up ? 'up' : 'ringing';
}

/** The listed fields of a dialled leg that apply to it. */
function legFacts(leg: Leg | GroupLeg): Partial<LiveLeg> {
  return {
    ...(leg.userId === null ? {} : { userId: leg.userId }),
    ...(leg.deviceId === undefined ? {} : { deviceId: leg.deviceId }),
    ...('trunkId' in leg && leg.trunkId !== undefined
      ? { trunkId: leg.trunkId }
      : {}),
    ...('target' in leg && leg.target !== undefined
      ? { target: leg.target }
      : {})
  };
}

/** `call`'s dialled legs that ring or are up, the ring-group batch ringing it included. */
function dialledLegs(
  call: Call,
  role: 'callee' | 'added',
  heldChannelId: string | undefined
): ChannelLeg[] {
  const legs: ChannelLeg[] = [];
  for (const leg of [
    ...call.legs.values(),
    ...(call.batchLegs?.values() ?? [])
  ]) {
    if (leg.state !== 'ringing' && leg.state !== 'up') {
      continue;
    }
    legs.push({
      channelId: leg.channelId,
      leg: {
        id: leg.id,
        role,
        state: stateOf(leg.channelId, heldChannelId, leg.state === 'up'),
        ...legFacts(leg)
      }
    });
  }
  return legs;
}

/**
 * The parties in `call` now: its caller's channel while it is in the call (`ringing` until the
 * call is answered), every leg ringing or up for it, and every party added to its conversation,
 * whose own row shares its bridge (§10.2 "Three-way calls").
 */
export function legsWithChannels(store: StateStore, call: Call): ChannelLeg[] {
  const bridgeId = ownBridge(call);
  const held =
    bridgeId === null ? undefined : store.holds.get(bridgeId)?.channelId;
  const legs: ChannelLeg[] = [];
  const caller = call.callerChannelId;
  if (caller !== null && call.callerEnded !== true) {
    const userId = presentCallerUserId(call);
    legs.push({
      channelId: caller,
      leg: {
        id: call.callerLegId,
        role: 'caller',
        state: stateOf(caller, held, call.answeredAt !== null),
        ...(userId === null ? {} : { userId }),
        ...(call.callerTrunkId === undefined
          ? {}
          : { trunkId: call.callerTrunkId })
      }
    });
  }
  legs.push(...dialledLegs(call, 'callee', held));
  if (bridgeId !== null) {
    for (const { call: other } of store.calls.values()) {
      if (other.addedLeg === true && other.bridgeId === bridgeId) {
        legs.push(...dialledLegs(other, 'added', held));
      }
    }
  }
  return legs;
}

/** The parties in `call` now, as listed (§10.3 "Live calls"). */
export function liveLegs(store: StateStore, call: Call): LiveLeg[] {
  return legsWithChannels(store, call).map(({ leg }) => leg);
}

/** The leg `legId` of `call`, 404 `legNotFound` when the call holds none by that id. */
export function namedLeg(
  pipeline: Pipeline,
  call: Call,
  legId: string
): ChannelLeg {
  const leg = legsWithChannels(pipeline.deps.state, call).find(
    candidate => candidate.leg.id === legId
  );
  if (leg === undefined) {
    throw new ActionError(HTTP_NOT_FOUND, 'legNotFound', 'no such leg');
  }
  return leg;
}

/**
 * The conversation an action on leg `legId` of `call` acts in: the bridge, the named party, and
 * the other side (`byChannelId`), which transfers, parks or holds it as the actor's own channel
 * would. 409 `legNotUp` for a leg still ringing, `notBridged` for an added party's, whose own
 * call it is, or for a call with nobody on the other side.
 */
export function namedParty(
  pipeline: Pipeline,
  call: Call,
  legId: string
): { bridgeId: string; party: string; byChannelId: string } {
  const { leg, channelId } = namedLeg(pipeline, call, legId);
  if (leg.role === 'added') {
    throw notBridged();
  }
  if (leg.state === 'ringing') {
    throw new ActionError(HTTP_CONFLICT, 'legNotUp', 'the leg is not up');
  }
  const bridgeId = ownBridge(call);
  const byChannelId = otherChannelIn(call, channelId);
  if (bridgeId === null || byChannelId === null) {
    throw notBridged();
  }
  return { bridgeId, party: channelId, byChannelId };
}

/** The conversation `req` acts in: the leg it names (`namedParty`), else the actor's other
 * party, seen from the actor's channel (`transferrerChannel`); 409 `notBridged` without one. */
export function actedParty(
  pipeline: Pipeline,
  call: Call,
  req: { actorUserId: string; legId?: string | undefined }
): { bridgeId: string; party: string; byChannelId: string } {
  if (req.legId !== undefined) {
    return namedParty(pipeline, call, req.legId);
  }
  const conversation = bridgedParty(
    call,
    transferrerChannel(call, req.actorUserId)
  );
  if (conversation === null) {
    throw notBridged();
  }
  return conversation;
}
