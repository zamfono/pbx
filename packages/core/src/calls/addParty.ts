/** `*5<ext or number>` (§10.2 "Three-way calls"), its own module so `features.ts`'s feature-code
 * dispatch stays under the repository's `max-lines` lint rule. */
import type { Snapshot } from '../internal/server.js';
import { resolveAddedTarget, type AddedTarget } from './addPartyTarget.js';
import { settleAnswered } from './answer.js';
import { joinExistingBridgeOnAnswer, takeJoinBridge } from './bridgeJoin.js';
import { release, type Call } from './call.js';
import { activeCallOf, channelOf } from './callLookup.js';
import { concludeExhausted, concludeFinal } from './conclude.js';
import { dialEmergency } from './emergency.js';
import {
  RELEASE_CODE_FORBIDDEN,
  RELEASE_CODE_UNAVAILABLE
} from './featureCall.js';
import { originateExternalLeg } from './outboundExternal.js';
import type { Pipeline } from './pipeline.js';
import { ringGroup } from './ringGroup.js';
import type { TrunkState } from './trunkState.js';
import { runUserStep } from './userStep.js';

/**
 * The added leg answered: it joined the running call's bridge through the answer path
 * (`answer.ts`), or was hung up there when that bridge was already gone. `call`'s own channel
 * was only ever the feature-code dial, so it is hung up like any other feature call's
 * disposable one, but the row stays open (§10.2 "Three-way calls": "The added leg is its own
 * calls row", ended when the added party leaves). Its `ChannelDestroyed` must not close this call
 * out (`legsEnded.ts`'s `endCallerCall` would end the row and drop the added party's presence
 * while they are still bridged, §9.3), so the channel leaves `callByChannel` first; the added
 * leg's own channel still reaches this call through it, and that leg ending is what ends the row
 * (`call.addedLeg`) and returns the party to idle.
 */
async function releaseFeatureDial(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  pipeline.callByChannel.delete(call.callerChannelId);
  await pipeline.deps.ari.channels
    .hangup(call.callerChannelId)
    .catch(() => undefined);
}

/** An internal target (§10.1 steps 4-5) rung on a fresh pass over `call`, its win joining
 * `activeBridgeId` through `joinExistingBridgeOnAnswer`. Whether the added party joined. */
async function ringInternalTarget(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  activeBridgeId: string,
  target: Extract<AddedTarget, { kind: 'user' | 'ringGroup' }>
): Promise<boolean> {
  joinExistingBridgeOnAnswer(pipeline, call.id, activeBridgeId);
  if (target.kind === 'user') {
    call.calleeUserId = target.userId;
    await runUserStep(pipeline, call, snapshot, target.userId);
  } else {
    await ringGroup(pipeline, call, target.ringGroupId);
  }
  // A ring that never won leaves the registry entry behind; nothing reads it after this point.
  takeJoinBridge(pipeline, call.id);
  if (call.status === 'answered') {
    await releaseFeatureDial(pipeline, call);
  }
  return call.bridgeId === activeBridgeId;
}

/** An external number dialled through `outbound_routes` (§9.4), as the initiator's call with the
 * CLIR prefix dialled with it, its answer joining `activeBridgeId`. Whether the party joined. */
async function dialExternalTarget(
  ctx: { pipeline: Pipeline; trunkState: TrunkState },
  call: Call,
  activeBridgeId: string,
  target: Extract<AddedTarget, { kind: 'external' }>
): Promise<boolean> {
  const { pipeline } = ctx;
  const result = await originateExternalLeg(
    ctx,
    call,
    target.number,
    target.withCaller ? call.callerUserId : null,
    target.clir
  );
  if (result.kind === 'answered') {
    await settleAnswered(pipeline, call, result.channelId, activeBridgeId);
    await releaseFeatureDial(pipeline, call);
    return call.bridgeId === activeBridgeId;
  }
  if (result.kind === 'final') {
    await concludeFinal(pipeline, call, result.failure);
    return false;
  }
  await concludeExhausted(pipeline, call, result.lastFailureKind);
  return false;
}

/**
 * Dials `*5`'s target, resolved like any dialled string (`addPartyTarget.ts`): a user or
 * ring-group target re-enters the normal per-user or ring-group routing — `runUserStep`/
 * `ringGroup`, the same functions Entry itself dispatches to (§10.1 steps 4-5) — so its forward
 * rules, find-me legs and the ring group's own strategy all apply exactly as they would for any
 * other call to it; `joinExistingBridgeOnAnswer` (the mechanism `parking.ts`'s ring-back also
 * uses) makes the winning leg join `activeBridgeId` in place of a bridge of its own. An external
 * number goes through §9.4's route selection, an emergency number through `emergency.ts`, and
 * either answer joins the bridge through `answer.ts`'s `settleAnswered`. `call.to` and
 * `call.direction` become the pipeline's view of the target (§11.2 `calls`). `call`'s own
 * channel, never part of the added leg, is released once the dial settles. Whether the added
 * party joined. Shared with the party `api` adds (`addedParty.ts`), whose call has no channel.
 */
export async function dialAddPartyTarget(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  activeBridgeId: string,
  rest: string
): Promise<boolean> {
  const target = resolveAddedTarget(snapshot, rest);
  call.log.event({ event: 'addPartyTarget', target: target.kind });
  if (target.kind === 'refuse') {
    await release(pipeline, call, target.code, 'failed');
    return false;
  }
  if (target.kind === 'user' || target.kind === 'ringGroup') {
    call.to = target.to;
    return ringInternalTarget(pipeline, call, snapshot, activeBridgeId, target);
  }
  call.to = target.number;
  call.direction = 'outbound';
  const trunkState = pipeline.deps.trunkState;
  if (trunkState === null) {
    await release(pipeline, call, RELEASE_CODE_UNAVAILABLE, 'failed');
    return false;
  }
  if (target.kind === 'external') {
    return dialExternalTarget(
      { pipeline, trunkState },
      call,
      activeBridgeId,
      target
    );
  }
  // §10.1 "Emergency calls": the routing trace is kept at level `events`.
  call.log.raise('events');
  joinExistingBridgeOnAnswer(pipeline, call.id, activeBridgeId);
  await dialEmergency(
    pipeline,
    trunkState,
    call,
    target.number,
    call.callerUserId
  );
  takeJoinBridge(pipeline, call.id);
  if (call.bridgeId !== activeBridgeId) {
    return false;
  }
  await releaseFeatureDial(pipeline, call);
  return true;
}

/** `*5<ext or number>`: joins the first to answer into the caller's own bridge (§10.2
 * "Three-way calls"). */
export async function addParty(
  pipeline: Pipeline,
  call: Call,
  rest: string
): Promise<void> {
  if (call.callerUserId === null) {
    await release(pipeline, call, RELEASE_CODE_FORBIDDEN, 'failed');
    return;
  }
  const active = activeCallOf(pipeline, call.callerUserId);
  const activeBridgeId = active?.bridgeId ?? null;
  if (active === null || activeBridgeId === null) {
    await release(pipeline, call, RELEASE_CODE_UNAVAILABLE, 'failed');
    return;
  }

  call.parentCallId = active.id;
  call.addedLeg = true;
  const snapshot = await pipeline.deps.cache.get();
  const joined = await dialAddPartyTarget(
    pipeline,
    call,
    snapshot,
    activeBridgeId,
    rest
  );
  // The bridge now mixes three parties, and the initiator is the one whose leaving ends it for
  // everyone (§10.2 "Three-way calls"); the added party leaving leaves the other two talking.
  const initiatorChannel = channelOf(active, call.callerUserId);
  if (joined && initiatorChannel !== null) {
    active.threeWayInitiatorChannelId = initiatorChannel;
  }
}
