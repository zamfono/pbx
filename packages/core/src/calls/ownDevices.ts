/**
 * The ring an action starts on a user's own phones (§10.2 "Click-to-dial": "rings the user's
 * devices first"; §10.1 "Pickup" over the API). Each device is placed as any leg is
 * (`legOriginate.ts`: created, joined to the call's SIP capture, then dialled) and raced by the
 * same machinery a user's ring is (`legs.ts`): the first to answer wins, the others are hung up,
 * and a ring whose every device fails, declines or rings out is unanswered. The call hosting the
 * race has no caller channel while it rings; the answered channel is handed back to the action
 * (`RingResolver.handOver`), which makes it the caller of the click-to-dial call, or dials the
 * pickup code with it.
 */
import { MS_PER_SECOND } from '@zamfono/shared';

import type { Channel } from '../ari/types.js';
import type { Snapshot } from '../internal/server.js';
import { channelLanguageVariable } from '../prompts.js';
import type { Call, Leg } from './call.js';
import { recordEvents, redeliverEarlyEvents } from './earlyEvents.js';
import { originateLeg } from './legOriginate.js';
import {
  concludeRing,
  hangupLeg,
  trackLeg,
  type RingOutcome,
  type RingResolver
} from './legs.js';
import type { Pipeline } from './pipeline.js';
import { placeAll } from './ringConclusion.js';

export type Device = Snapshot['devices'][number];

export type OwnRingParams = {
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
export type OwnRingOutcome =
  | { kind: 'answered'; channel: Channel }
  | { kind: 'unanswered' }
  | { kind: 'abandoned' };

export type OwnRing = {
  /** Settles once every device is placed or has failed to be. */
  placed: Promise<void>;
  outcome: Promise<OwnRingOutcome>;
};

/** This ring's own state: the channels it placed, and its race on the host call's
 * `pendingRing`, which the call's next ring replaces once this one has handed its answer over. */
type OwnRingState = { placed: Map<string, Channel>; ring: RingResolver };

/** Places one leg for `device` on `host`, tracked as a ringing device leg. A placement that
 * fails leaves the ring; one placed after the race settled is hung up, even once the host call
 * rings on for its next party. */
async function placeDevice(
  pipeline: Pipeline,
  params: OwnRingParams,
  own: OwnRingState,
  device: Device
): Promise<void> {
  const { placed } = own;
  const { host, sipCall, userId, callerId, language } = params;
  const early = recordEvents(pipeline.deps.ari);
  const channel = await originateLeg(pipeline, sipCall, {
    endpoint: `PJSIP/${device.sipUsername}`,
    app: 'zamfono',
    appArgs: `leg,${host.id}`,
    callerId,
    variables: channelLanguageVariable(language)
  })
    .catch(() => null)
    .finally(early.stop);
  if (channel === null) {
    host.log.event({
      event: 'rungDevice',
      deviceId: device.id,
      userId,
      cause: 'placementFailed'
    });
    return;
  }
  placed.set(channel.id, channel);
  trackLeg(pipeline, host, {
    channelId: channel.id,
    kind: 'device',
    userId,
    state: 'ringing',
    endCause: null,
    deviceId: device.id
  });
  host.log.event({ event: 'rungDevice', channelId: channel.id, userId });
  // A phone that declined or answered at once did so before it was tracked.
  redeliverEarlyEvents(pipeline.deps.ari, early, channel.id);
  const leg = host.legs.get(channel.id);
  if (
    pipeline.pendingRing.get(host.id) !== own.ring &&
    leg?.state === 'ringing'
  ) {
    await hangupLeg(pipeline, leg);
  }
}

/** Places one leg per device on `host`, all at once (`placeAll`), each in its own order (created,
 * joined, dialled). */
async function placeDevices(
  pipeline: Pipeline,
  params: OwnRingParams,
  own: OwnRingState
): Promise<void> {
  await placeAll(pipeline, params.host, params.devices, device =>
    placeDevice(pipeline, params, own, device)
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
    handOver: leg => {
      answered = leg;
    }
  };
  pipeline.pendingRing.set(host.id, ring);
  presence?.setCallState(userId, 'ringing', peer, null, presenceKey);
  const own: OwnRingState = { placed: new Map<string, Channel>(), ring };
  const { placed } = own;
  const outcome = promise.then((result): OwnRingOutcome => {
    presence?.setCallState(userId, 'idle', null, null, presenceKey);
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
