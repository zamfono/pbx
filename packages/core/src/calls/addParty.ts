/** `*5<ext or number>` (§10.2 "Three-way calls"): a third party added to the caller's call. */
import { ignoreGone } from '../ari/failures.js';
import type { Snapshot } from '../internal/snapshot.js';
import { SIP_FORBIDDEN, SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { resolveAddedTarget, type AddedTarget } from './addPartyTarget.js';
import { type Call } from './call.js';
import { activeCallOf, channelOf } from './callLookup.js';
import { dialEmergency } from './emergency.js';
import { dialSipTarget } from './forwardDial.js';
import { enterTarget } from './inbound.js';
import { dialExternal } from './outboundExternal.js';
import type { Pipeline } from './pipeline.js';
import { release } from './release.js';
import { ringGroup } from './ringGroup.js';
import type { TrunkChannels } from './trunkChannels.js';
import { runUserStep } from './userStep.js';

/**
 * The added leg answered: it joined the running call's bridge through the answer path
 * (`answer.ts`), or was hung up there when that bridge was already gone. `call`'s own channel,
 * where it has one, was only ever the feature-code dial, so it is hung up like any other feature
 * call's disposable one, but the row stays open (§10.2 "Three-way calls": "The added leg is its own
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
  if (call.callerChannelId === null) {
    return;
  }
  pipeline.callByChannel.delete(call.callerChannelId);
  await pipeline.deps.ari.channels
    .hangup(call.callerChannelId)
    .catch(ignoreGone);
}

/** Once the added leg's dial settled: the feature dial released if the leg answered, and whether
 * the added party joined `activeBridgeId`. */
async function joinedAfterDial(
  pipeline: Pipeline,
  call: Call,
  activeBridgeId: string
): Promise<boolean> {
  if (call.status === 'answered') {
    await releaseFeatureDial(pipeline, call);
  }
  return call.bridgeId === activeBridgeId;
}

/** An internal target on a fresh pass over `call`, its win joining `activeBridgeId`: `*5`'s
 * enters at Entry like any dialled extension, OOO and opening hours included (§10.1); `api`'s,
 * with no caller channel, is only rung (§10.1 steps 4-5), a forward or mailbox handed back left
 * undone. Whether the added party joined. */
async function ringInternalTarget(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  activeBridgeId: string,
  target: Extract<AddedTarget, { kind: 'user' | 'ringGroup' }>
): Promise<boolean> {
  if (call.callerChannelId !== null) {
    const entered =
      target.kind === 'user'
        ? { kind: target.kind, userId: target.userId }
        : { kind: target.kind, ringGroupId: target.ringGroupId };
    await enterTarget(pipeline, call, entered, null);
  } else if (target.kind === 'user') {
    call.calleeUserId = target.userId;
    await runUserStep(pipeline, call, snapshot, target.userId);
  } else {
    await ringGroup(pipeline, call, target.ringGroupId);
  }
  return joinedAfterDial(pipeline, call, activeBridgeId);
}

/** An external number dialled through `outbound_routes` (§9.4), as the initiator's call with the
 * CLIR prefix dialled with it, or as a DID's own forward, its answer joining `activeBridgeId`.
 * Whether the party joined. */
async function dialExternalTarget(
  ctx: { pipeline: Pipeline; trunkChannels: TrunkChannels },
  call: Call,
  activeBridgeId: string,
  target: Extract<AddedTarget, { kind: 'external' }>
): Promise<boolean> {
  await dialExternal(
    { ...ctx, forward: target.forward },
    call,
    target.number,
    target.forward === undefined ? call.callerUserId : null,
    target.clir
  );
  return joinedAfterDial(ctx.pipeline, call, activeBridgeId);
}

/**
 * Dials `*5`'s target, resolved like any dialled string (`addPartyTarget.ts`): a user or
 * ring-group target enters the normal routing (`ringInternalTarget`), so its OOO rule, forward
 * rules, find-me legs and the ring group's own strategy all apply exactly as they would for any
 * other call to it. An external number goes through §9.4's route selection, an own DID's SIP
 * target over its own trunk (§9.4 "SIP targets"), an emergency number through `emergency.ts`.
 * Whichever answers joins `activeBridgeId` in place of a bridge of its own, through
 * `Call.joinBridgeId` (as `parking.ts`'s ring-back also sets it). `call.to` and `call.direction`
 * become the pipeline's view of the target (§11.2 `calls`). `call`'s own channel, never part of
 * the added leg, is released once the dial settles. Whether the added party joined. Shared with
 * the party `api` adds (`addedParty.ts`), whose call has no caller channel.
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
  call.joinBridgeId = activeBridgeId;
  try {
    if (target.kind === 'user' || target.kind === 'ringGroup') {
      call.to = target.to;
      return await ringInternalTarget(
        pipeline,
        call,
        snapshot,
        activeBridgeId,
        target
      );
    }
    call.direction = 'outbound';
    const { trunkChannels } = pipeline.deps;
    if (target.kind === 'sip') {
      call.to = target.to;
      // The DID forwards, as nobody's call (§10.1 step 7).
      await dialSipTarget(
        { pipeline, trunkChannels },
        call,
        target.target,
        null
      );
      return await joinedAfterDial(pipeline, call, activeBridgeId);
    }
    call.to = target.number;
    if (target.kind === 'external') {
      return await dialExternalTarget(
        { pipeline, trunkChannels },
        call,
        activeBridgeId,
        target
      );
    }
    // §10.1 "Emergency calls": the routing trace is kept at level `events`.
    call.log.raise('events');
    await dialEmergency(
      pipeline,
      trunkChannels,
      call,
      target.number,
      call.callerUserId
    );
  } finally {
    // A dial whose answer never took the bridge leaves it behind; nothing reads it after this.
    delete call.joinBridgeId;
  }
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
    await release(pipeline, call, SIP_FORBIDDEN, 'failed');
    return;
  }
  const active = activeCallOf(pipeline, call.callerUserId);
  const activeBridgeId = active?.bridgeId ?? null;
  if (active === null || activeBridgeId === null) {
    await release(pipeline, call, SIP_TEMPORARILY_UNAVAILABLE, 'failed');
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
