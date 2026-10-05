/**
 * The ring an action starts on a user's own phones (§10.2 "Click-to-dial": "rings the user's
 * devices first"; §10.1 "Pickup" over the API). Each device is placed as any leg is
 * (`legOriginate.ts`: created, joined to the call's SIP capture, then dialled) and raced by the
 * same machinery a user's ring is (`legs.ts`): the first to answer wins, the others are hung up,
 * and a ring whose every device fails, declines or rings out is unanswered. The call hosting the
 * race has no caller channel while it rings; the answered channel is handed back to the action
 * (`RingResolver.handOver`), which makes it the caller of the click-to-dial call, or the
 * picked-up call's answer.
 */
import { MS_PER_SECOND, newId } from '@zamfono/shared';

import type { Channel } from '../ari/types.js';
import { userById, type Snapshot } from '../internal/snapshot.js';
import { channelLanguageVariable } from '../prompts.js';
import type { Call, Leg } from './call.js';
import { callPartiesChanged } from './callState.js';
import { originateLeg } from './legOriginate.js';
import {
  hangupLeg,
  trackLeg,
  untrackLeg,
  type RingOutcome,
  type RingResolver
} from './legs.js';
import type { Pipeline } from './pipeline.js';
import { concludeRing, placeAll } from './ringConclusion.js';
import { contactLegs, type ContactLeg } from './userDevices.js';

export type Device = Snapshot['devices'][number];

// `users.ring_timeout_s`'s column default (§11.2).
const DEFAULT_RING_TIMEOUT_S = 25;

/** `users.ring_timeout_s` (§11.2): the user's own, or the column's default for an unknown user. */
export function ringTimeoutOf(snapshot: Snapshot, userId: string): number {
  const user = userById(snapshot, userId);
  return user?.ringTimeoutS ?? DEFAULT_RING_TIMEOUT_S;
}

type OwnRingParams = {
  /** The call whose legs the devices are, and whose ring race they run in. */
  host: Call;
  /** The call whose SIP capture each device's dialog joins (§7 level `sip`): the host itself, or
   * for a pickup the call being picked up, which the answered device goes on to take. */
  sipCall: Call;
  userId: string;
  devices: readonly Device[];
  callerId: string;
  timeoutS: number;
  // §9.1 "every channel's language", set from the leg's creation.
  language: string;
  /** §9.3 "a user: RINGING while any of their devices rings": whom the user's phones show, under
   * which per-call presence key, until the ring settles. */
  peer: string;
  presenceKey: string;
};

/** How the ring ended: the answered device's channel, no answer, or the ring stopped outright
 * (`abandoned`, a REST hangup), after which nothing follows. */
type OwnRingOutcome =
  | { kind: 'answered'; channel: Channel }
  | { kind: 'unanswered' }
  | { kind: 'abandoned' };

type OwnRing = {
  /** Settles once every device is placed or has failed to be. */
  placed: Promise<void>;
  outcome: Promise<OwnRingOutcome>;
};

/** This ring's own state: the channels it placed, and its race on the host call's
 * `pendingRing`, which the call's next ring replaces once this one has handed its answer over. */
type OwnRingState = { placed: Map<string, Channel>; ring: RingResolver };

/** Places one leg for a contact of `device`'s on `host`, tracked as a device leg: placing, then
 * ringing. A
 * placement that fails leaves the ring; one placed after the race settled is hung up, even once
 * the host call rings on for its next party. */
async function placeDevice(
  pipeline: Pipeline,
  params: OwnRingParams,
  own: OwnRingState,
  { device, endpoint }: ContactLeg
): Promise<void> {
  const { placed } = own;
  const { host, sipCall, userId, callerId, language } = params;
  const leg: Leg = {
    id: newId(),
    channelId: newId(),
    kind: 'device',
    userId,
    state: 'placing',
    endCause: null,
    deviceId: device.id
  };
  trackLeg(pipeline, host, leg);
  const ok = await originateLeg(
    pipeline,
    sipCall,
    {
      channelId: leg.channelId,
      endpoint,
      app: 'zamfono',
      appArgs: `leg,${host.id}`,
      callerId,
      variables: channelLanguageVariable(language)
    },
    channel => {
      placed.set(channel.id, channel);
      leg.state = 'ringing';
      host.log.event({ event: 'rungDevice', channelId: channel.id, userId });
    }
  ).then(
    () => true,
    () => false
  );
  if (!ok) {
    untrackLeg(pipeline, host, leg);
    host.log.event({
      event: 'rungDevice',
      deviceId: device.id,
      userId,
      cause: 'placementFailed'
    });
    return;
  }
  callPartiesChanged(pipeline.deps, host);
  const tracked = host.legs.get(leg.channelId);
  if (
    pipeline.pendingRing.get(host.id) !== own.ring &&
    tracked?.state === 'ringing'
  ) {
    await hangupLeg(pipeline, tracked);
  }
}

/** Places one leg per reachable contact of each device on `host`, all at once (`placeAll`), each in
 * its own order (created, joined, dialled). */
async function placeDevices(
  pipeline: Pipeline,
  params: OwnRingParams,
  own: OwnRingState
): Promise<void> {
  const legs = await contactLegs(pipeline, params.devices);
  await placeAll(pipeline, params.host, legs, leg =>
    placeDevice(pipeline, params, own, leg)
  );
  // Nothing rings: no device could be placed, or each ended before the last was. Only this ring
  // is concluded, never the call's next one begun meanwhile.
  const ringing = [...params.host.legs.values()].some(
    leg => leg.state === 'ringing'
  );
  if (!ringing) {
    concludeRing(pipeline, params.host, own.ring);
  }
}

/** Starts ringing `params.devices` on `params.host`; the ring times out after `timeoutS`. */
export function ringOwnDevices(
  pipeline: Pipeline,
  params: OwnRingParams
): OwnRing {
  const { host, userId, peer, presenceKey } = params;
  const { presence } = pipeline.deps;
  const { promise, resolve } = Promise.withResolvers<RingOutcome>();
  let answered: Leg | null = null;
  const timer = setTimeout(() => {
    concludeRing(pipeline, host);
  }, params.timeoutS * MS_PER_SECOND);
  timer.unref();
  const ring: RingResolver = {
    resolve,
    timer,
    existingBridgeId: null,
    placing: 0,
    handOver: leg => {
      answered = leg;
    }
  };
  pipeline.pendingRing.set(host.id, ring);
  presence.setCallState(userId, 'ringing', peer, null, presenceKey);
  const own: OwnRingState = { placed: new Map<string, Channel>(), ring };
  const { placed } = own;
  const outcome = promise.then((result): OwnRingOutcome => {
    presence.setCallState(userId, 'idle', null, null, presenceKey);
    const leg = answered;
    const channel = leg === null ? undefined : placed.get(leg.channelId);
    if (result === 'answered' && channel !== undefined) {
      return { kind: 'answered', channel: { ...channel, state: 'Up' } };
    }
    return result === 'abandoned'
      ? { kind: 'abandoned' }
      : { kind: 'unanswered' };
  });
  return { placed: placeDevices(pipeline, params, own), outcome };
}

/** Stops `host`'s ring outright (a REST hangup): its outcome is `abandoned`, and the call's own
 * close (`closeCall`) hangs up the devices still ringing. */
export function abandonOwnRing(pipeline: Pipeline, host: Call): void {
  pipeline.pendingRing.get(host.id)?.resolve('abandoned');
}
