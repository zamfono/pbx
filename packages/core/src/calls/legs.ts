// The ring race's legs (§10.1 step 4): tracking and ending them, the first accepted answer
// winning, and the ARI events that answer a leg (a device picking up, find-me's accept key).
// `ringUser.ts` starts the race; `ringConclusion.ts` settles it when legs end without an answer.

import type { AriEvent, Channel } from '../ari/types.js';
import { bridgeAnswered, claimAnswer } from './answer.js';
import type { Call, Leg } from './call.js';
import {
  beginFindMeAccept,
  clearFindMeTimers,
  FIND_ME_ACCEPT_DIGIT,
  FIND_ME_REJECT_DIGIT
} from './findMe.js';
import type { Pipeline } from './pipeline.js';

export { joinExistingBridgeOnAnswer } from './bridgeJoin.js';
export { clearFindMeTimers } from './findMe.js';
export { handleChannelEnded } from './legsEnded.js';
export { concludeRing } from './ringConclusion.js';

export type RingOutcome = 'answered' | 'abandoned' | 'busy' | 'noAnswer';

export type RingResolver = {
  resolve: (outcome: RingOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  // --- Task 31 --- The bridge the win joins in place of its own (`winLeg`), `null` for a fresh one.
  existingBridgeId: string | null;
  // --- end Task 31 ---
  /** Set for a ring on a user's own phones that an action started (`ownDevices.ts`): the leg that
   * answers is handed to it instead of being bridged with a caller the call does not have yet. */
  handOver?: (leg: Leg) => void;
  /** Device legs still being placed, all at once (`ringUser.ts`, `ownDevices.ts`): the race does
   * not end on its last ringing leg while one is still to ring. */
  placing?: number;
};

/** A find-me leg awaiting its accept key; `timer`, the accept window, starts once the prompt
 * has played out (`findMe.ts`). */
export type FindMeAcceptWait = {
  call: Call;
  leg: Leg;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export function trackLeg(pipeline: Pipeline, call: Call, leg: Leg): void {
  call.legs.set(leg.channelId, leg);
  pipeline.callByChannel.set(leg.channelId, call);
}

export function endLeg(pipeline: Pipeline, channelId: string, leg: Leg): void {
  leg.state = 'ended';
  pipeline.callByChannel.delete(channelId);
  pipeline.pendingFindMeAccept.delete(channelId);
}

/** Ends `leg` and hangs up its still-live channel; never for a channel that already ended itself. */
export function hangupLeg(pipeline: Pipeline, leg: Leg): Promise<void> {
  endLeg(pipeline, leg.channelId, leg);
  return pipeline.deps.ari.channels
    .hangup(leg.channelId)
    .catch(() => undefined);
}

/**
 * The first accepted answer: bridges it with the caller and ends every other leg. With
 * `existingBridgeId` (Task 31: §10.2 "Call parking"'s ring-back, "Three-way calls"'s `*5`) the
 * winning leg joins that bridge in place of one of its own, and `call.callerChannelId` — a
 * placeholder channel for parking's synthetic ring-back call, or `*5`'s own disposable
 * feature-code channel — is left untouched.
 */
async function winLeg(
  pipeline: Pipeline,
  call: Call,
  leg: Leg,
  existingBridgeId: string | null
): Promise<void> {
  if (!claimAnswer(pipeline, call, leg)) {
    await hangupLeg(pipeline, leg);
    return;
  }
  clearFindMeTimers(pipeline, call.id);
  const pending = pipeline.pendingRing.get(call.id);
  if (pending) {
    clearTimeout(pending.timer);
  }
  const joined = await bridgeAnswered(pipeline, call, leg, existingBridgeId);
  for (const other of call.legs.values()) {
    if (other.channelId !== leg.channelId && other.state === 'ringing') {
      // eslint-disable-next-line no-await-in-loop -- losing legs are hung up one at a time; there are at most a handful per call
      await hangupLeg(pipeline, other);
    }
  }
  pipeline.pendingRing.delete(call.id);
  // --- Task 31 --- (§9.3 "a user: ... INUSE in a call"; a leg whose join failed is hung up)
  if (leg.userId !== null && joined) {
    pipeline.deps.presence?.setCallState(
      leg.userId,
      'inCall',
      call.from,
      null,
      call.id
    );
  }
  // --- end Task 31 ---
  pending?.resolve('answered');
}

/**
 * The first answer of a ring on a user's own phones (`ownDevices.ts`): the race ends as any does,
 * every other ringing leg hung up, and the answered channel leaves the call's legs for whoever
 * started the ring, which makes it the caller of a call (click-to-dial) or dials with it (pickup).
 */
async function handOverLeg(
  pipeline: Pipeline,
  call: Call,
  leg: Leg,
  pending: RingResolver
): Promise<void> {
  clearTimeout(pending.timer);
  pipeline.pendingRing.delete(call.id);
  call.legs.delete(leg.channelId);
  pipeline.callByChannel.delete(leg.channelId);
  for (const other of call.legs.values()) {
    if (other.state === 'ringing') {
      // eslint-disable-next-line no-await-in-loop -- a user has at most a handful of devices
      await hangupLeg(pipeline, other);
    }
  }
  pending.handOver?.(leg);
  pending.resolve('answered');
}

/** `ChannelStateChange` Up for a ringing leg: the find-me accept prompt, or straight to `winLeg`. */
export async function legWentUp(
  pipeline: Pipeline,
  channelId: string
): Promise<void> {
  const call = pipeline.callByChannel.get(channelId);
  const leg = call?.legs.get(channelId);
  if (call === undefined || leg?.state !== 'ringing') {
    return;
  }
  const pending = pipeline.pendingRing.get(call.id);
  if (call.answeredAt !== null || pending === undefined) {
    await hangupLeg(pipeline, leg);
    return;
  }
  if (pending.handOver !== undefined) {
    await handOverLeg(pipeline, call, leg, pending);
    return;
  }
  if (leg.kind === 'findMe') {
    beginFindMeAccept(pipeline, call, leg);
    return;
  }
  await winLeg(pipeline, call, leg, pending.existingBridgeId);
}

/** A DTMF key on a find-me leg awaiting its accept: `1` wins the race for it, `2` drops the leg
 * as the prompt offers (§10.1 step 4). */
export function handleDtmf(pipeline: Pipeline, ev: AriEvent): void {
  const channelId = (ev.channel as Channel).id;
  const pending = pipeline.pendingFindMeAccept.get(channelId);
  if (
    pending === undefined ||
    (ev.digit !== FIND_ME_ACCEPT_DIGIT && ev.digit !== FIND_ME_REJECT_DIGIT)
  ) {
    return;
  }
  clearTimeout(pending.timer);
  pipeline.pendingFindMeAccept.delete(channelId);
  if (ev.digit === FIND_ME_REJECT_DIGIT) {
    hangupLeg(pipeline, pending.leg).catch(() => undefined);
    return;
  }
  const existingBridgeId =
    pipeline.pendingRing.get(pending.call.id)?.existingBridgeId ?? null;
  winLeg(pipeline, pending.call, pending.leg, existingBridgeId).catch(
    () => undefined
  );
}
