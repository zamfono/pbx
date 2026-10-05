/**
 * The one answer path every answered call takes, whoever answers it: the single-user ring race
 * (`legs.ts`), a ring-group batch (`ringGroupWin.ts`), an outbound or emergency dial
 * (`outboundExternal.ts`, `emergency.ts`), `*5` to an external number (`addParty.ts`) and pickup
 * (`features.ts`). An answer is claimed synchronously, so a second one landing while the first is
 * still bridging loses (§10.1 step 4: "the first answer wins"); the claimed leg is then bridged,
 * its participations offered to the recorder (§10.2 "Recording semantics"), and the live view
 * told the call is up (§10.6).
 */
import { newId } from '@zamfono/shared';

import { isGone, logUnlessGone } from '../ari/failures.js';
import {
  callerChannel,
  takeEarlyBridge,
  takeJoinBridge,
  type Call,
  type Leg
} from './call.js';
import { callUp } from './callState.js';
import { traceCodecs } from './codecTrace.js';
import type { Pipeline } from './pipeline.js';
import { recordAnsweredParticipation } from './recordParticipation.js';

/** What the `answered` line says of the leg that answered: its channel and kind, and whose it is —
 * the trunk a `trunk` leg went out over, else the user and, for a phone, the device. */
function answeredLeg(leg: Leg): Record<string, unknown> {
  const owner =
    leg.kind === 'trunk'
      ? { trunkId: leg.trunkId ?? null }
      : { userId: leg.userId };
  return {
    channelId: leg.channelId,
    leg: leg.kind,
    ...owner,
    ...(leg.deviceId === undefined ? {} : { deviceId: leg.deviceId })
  };
}

/**
 * Makes `leg` the answer of `call`, or returns false when another answer already won. Runs no
 * await, so the check and the claim cannot be split by a second answer's event. The claim writes
 * the call's one `answered` trace line (§7 "answers and declines"), with `trace` adding what the
 * answer path knows about it, and maps the leg's channel so its own hangup ends the call.
 */
export function claimAnswer(
  pipeline: Pipeline,
  call: Call,
  leg: Leg,
  trace: Record<string, unknown> = {}
): boolean {
  if (call.answeredAt !== null) {
    return false;
  }
  call.answeredAt = pipeline.deps.now();
  call.answeredByUserId = leg.userId;
  call.status = 'answered';
  leg.state = 'up';
  call.legs.set(leg.channelId, leg);
  pipeline.callByChannel.set(leg.channelId, call);
  call.log.event({ event: 'answered', ...answeredLeg(leg), ...trace });
  return true;
}

/**
 * Joins a claimed `leg` to `bridgeId`, a bridge the call it is added to already has. Returns false
 * when that fails, which happens only once the bridge is gone: the call it joined has ended, the
 * way "the initiator hanging up ends the bridge for everyone" (§10.2 "Three-way calls"), so the
 * answered leg is hung up rather than left in Stasis with nobody, and its own `ChannelDestroyed`
 * then ends it like any answered leg's.
 */
async function joinBridge(
  pipeline: Pipeline,
  call: Call,
  leg: Leg,
  bridgeId: string
): Promise<boolean> {
  const { ari } = pipeline.deps;
  try {
    await ari.bridges.addChannel(bridgeId, leg.channelId);
  } catch {
    call.log.event({ event: 'joinFailed', bridgeId, channelId: leg.channelId });
    await ari.channels.hangup(leg.channelId).catch(
      logUnlessGone(pipeline.deps.logger, 'unjoined leg hangup', {
        callId: call.id
      })
    );
    return false;
  }
  call.bridgeId = bridgeId;
  return true;
}

/**
 * Answers the caller and bridges `leg` with them in a fresh bridge. False when a party left
 * meanwhile, the caller hanging up as their phone was answered: that party's end found no
 * conversation to release (`legsEnded.ts`), so the other is hung up and the bridge destroyed
 * here, as a party leaving a two-party call does.
 */
async function bridgeWithCaller(
  pipeline: Pipeline,
  call: Call,
  leg: Leg
): Promise<boolean> {
  const { ari, logger } = pipeline.deps;
  const callerChannelId = callerChannel(call);
  let bridgeId: string | null = null;
  try {
    await ari.channels.answer(callerChannelId);
    // A waiting dial's early bridge already holds the caller and the leg that answered.
    bridgeId = takeEarlyBridge(call);
    if (bridgeId === null) {
      ({ id: bridgeId } = await ari.bridges.create({ type: 'mixing' }));
      await ari.bridges.addChannel(bridgeId, callerChannelId);
      // eslint-disable-next-line require-atomic-updates -- the answer is this caller's own claim (`claimAnswer`); nothing else writes bridgeId
      call.bridgeId = bridgeId;
      await ari.bridges.addChannel(bridgeId, leg.channelId);
    } else {
      call.bridgeId = bridgeId;
    }
    if (call.callerEnded !== true) {
      return true;
    }
  } catch (error) {
    if (!isGone(error)) {
      throw error;
    }
  }
  const fields = { callId: call.id };
  await Promise.all(
    [leg.channelId, callerChannelId].map(channelId =>
      ari.channels
        .hangup(channelId)
        .catch(logUnlessGone(logger, 'party hangup', fields))
    )
  );
  if (bridgeId !== null) {
    await ari.bridges
      .destroy(bridgeId)
      .catch(logUnlessGone(logger, 'bridge destroy', fields));
  }
  return false;
}

/**
 * Bridges a claimed answer with the caller, then starts recording and publishes the call as up.
 * With `existingBridgeId` (§10.2 "Call parking"'s ring-back, "Three-way calls"'s `*5`) the leg
 * joins that bridge in place of a fresh one, and `call.callerChannelId` is left untouched.
 * Returns false when that bridge is gone (`joinBridge`) or a party left before a fresh one held
 * both (`bridgeWithCaller`); the answer stays claimed either way.
 */
export async function bridgeAnswered(
  pipeline: Pipeline,
  call: Call,
  leg: Leg,
  existingBridgeId: string | null = null
): Promise<boolean> {
  const { recorder } = pipeline.deps;
  if (existingBridgeId === null) {
    if (!(await bridgeWithCaller(pipeline, call, leg))) {
      return false;
    }
    // A snoop attaches to a bridged channel, so the recorder follows the bridge, not the answer.
    await recordAnsweredParticipation(recorder, call, leg);
  } else {
    if (!(await joinBridge(pipeline, call, leg, existingBridgeId))) {
      return false;
    }
    // The caller's channel, if any, is not in the bridge joined (`*5`'s feature dial), so the
    // joining leg is the one new participation (§10.2 "Three-way calls": "evaluates
    // Ben's participation on its own flags").
    await recorder.onLegUp(call, leg);
  }
  callUp(pipeline.deps, call);
  traceCodecs(
    pipeline,
    call,
    leg,
    existingBridgeId === null ? call.callerChannelId : null
  );
  return true;
}

/**
 * An outbound or emergency dial's answered trunk leg (§9.4): claims it and bridges it with the
 * caller, or joins it to the call's `joinBridgeId` (`*5` to an external or emergency number,
 * §10.2 "Three-way calls"). Returns false, hanging the channel up, when the call already had an
 * answer or the bridge to join is gone.
 */
export async function settleAnswered(
  pipeline: Pipeline,
  call: Call,
  channelId: string
): Promise<boolean> {
  const leg: Leg = call.legs.get(channelId) ?? {
    id: newId(),
    channelId,
    kind: 'trunk',
    userId: null,
    state: 'up',
    endCause: null
  };
  if (!claimAnswer(pipeline, call, leg)) {
    await pipeline.deps.ari.channels.hangup(channelId).catch(
      logUnlessGone(pipeline.deps.logger, 'late answer hangup', {
        callId: call.id
      })
    );
    return false;
  }
  return bridgeAnswered(pipeline, call, leg, takeJoinBridge(call));
}
