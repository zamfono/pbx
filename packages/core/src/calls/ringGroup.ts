/**
 * Routing pipeline step 5, "Target ring group" (§10.1, §10.2 "Ring groups"): expands the group's
 * membership into ringable legs, dials them per the group's strategy (`ringGroupDial.ts` owns each
 * batch's own ring race) and applies the group's fallback once ringing ends without an answer.
 * The members' state and the group's rules it decides on are `ringGroupState.ts`'s.
 */
import type { Snapshot } from '../internal/snapshot.js';
import { assetMedia } from '../prompts.js';
import {
  groupFallback,
  ringable,
  ringPlan,
  type Strategy
} from '../routing/ringGroup.js';
import { raiseLogLevel, release, type Call } from './call.js';
import { extensionOf } from './extensionOwner.js';
import { CONDITION_REASONS, diversionFor } from './forwardContext.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import { ringBatch } from './ringGroupDial.js';
import {
  buildGroupRules,
  buildMemberStates,
  type GroupOutcome,
  type GroupRules
} from './ringGroupState.js';
import { runTarget } from './runTarget.js';
import { busyDevices } from './userDevices.js';
import { deposit } from './voicemail.js';

const RELEASE_CODE_UNAVAILABLE = 480;
/** Answers the caller (no early media without it), plays the group's greeting to completion if it
 * has one (§10.2 "Ring groups"), then starts its MoH class in place of ringback. */
async function playGreetingAndMoh(
  pipeline: Pipeline,
  call: Call,
  groupId: string,
  snapshot: Snapshot,
  group: { greetingAudioId: string | null; mohAudioId: string | null }
): Promise<void> {
  await pipeline.deps.ari.channels
    .answer(call.callerChannelId)
    .catch(() => undefined);
  if (group.greetingAudioId !== null) {
    await playAndWait(
      pipeline.deps.ari,
      call.callerChannelId,
      assetMedia(snapshot.audioAssets, group.greetingAudioId),
      `${call.callerChannelId}:ringGroup:${groupId}`
    );
  }
  await pipeline.deps.ari.channels
    .startMoh(call.callerChannelId, group.mohAudioId ?? undefined)
    .catch(() => undefined);
}

/** Whether the call has already been concluded elsewhere — a function boundary keeps TypeScript
 * from narrowing `call.status` across the batch loop's awaits, when `endAbandonedCall` (legs.ts)
 * can set it from the caller's own `ChannelDestroyed` handler at any point control yields. */
function callEnded(call: Call): boolean {
  return call.status !== null;
}

/** Dispatches `groupFallback`'s decision once ringing ends without an answer (§10.1 step 5);
 * a call that only rings (`Call.ringOnly`) stops there, as a user's does (`userStep.ts`). */
async function applyGroupFallback(
  pipeline: Pipeline,
  call: Call,
  group: { mailboxEnabled: boolean; ringGroupId: string },
  rules: GroupRules,
  outcome: GroupOutcome
): Promise<void> {
  if (call.ringOnly === true) {
    return;
  }
  const action = groupFallback(group, rules, outcome);
  if (action.kind === 'forward') {
    // §10.1 step 7: a ring group's fallback forwards without a caller, a hop of the group's.
    const diversion = diversionFor(
      await pipeline.deps.cache.get(),
      call,
      { ringGroupId: group.ringGroupId },
      CONDITION_REASONS[outcome]
    );
    await runTarget(pipeline, call, action.target, null, diversion);
    return;
  }
  if (action.kind === 'mailbox') {
    await deposit(pipeline, call, { ringGroupId: action.ringGroupId }, outcome);
    return;
  }
  await release(pipeline, call, action.code, 'missed');
}

/** `ringGroup`'s batch-plan loop and fallback, its own function for `max-lines-per-function`. */
type BatchPlanCtx = {
  groupId: string;
  snapshot: Snapshot;
  group: { allowReject: number };
  groupInfo: { mailboxEnabled: boolean; ringGroupId: string };
  rules: GroupRules;
};

async function runBatchPlan(
  pipeline: Pipeline,
  call: Call,
  plan: ReturnType<typeof ringPlan>,
  ctx: BatchPlanCtx
): Promise<void> {
  let result: 'answered' | 'unanswered' | 'abandoned' = 'unanswered';
  for (const batch of plan) {
    if (callEnded(call)) {
      // The caller abandoned in the gap between two batches, where no ring race is listening yet.
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- batches ring one after another by the group's own strategy (sequential/random)
    result = await ringBatch(
      pipeline,
      call,
      ctx.snapshot,
      batch,
      ctx.group.allowReject === 1
    );
    if (result !== 'unanswered') {
      break;
    }
  }

  if (result === 'abandoned') {
    // The caller's own channel ending abandoned the call already, through legs.ts's
    // `handleChannelEnded` → `endAbandonedCall`: status and the CDR are already final.
    return;
  }

  if (result === 'unanswered') {
    await pipeline.deps.ari.channels
      .stopMoh(call.callerChannelId)
      .catch(() => undefined);
    call.log.event({
      event: 'ringGroup',
      groupId: ctx.groupId,
      result: 'unanswered'
    });
    await applyGroupFallback(
      pipeline,
      call,
      ctx.groupInfo,
      ctx.rules,
      'unanswered'
    );
  }
}

/**
 * Routing pipeline step 5 (§10.1): expands `groupId`'s membership, plays its greeting and MoH
 * class instead of ringback, dials the ringable legs per the group's strategy and applies its
 * fallback once ringing ends without an answer (§10.2 "Ring groups").
 */
export async function ringGroup(
  pipeline: Pipeline,
  call: Call,
  groupId: string,
  rng: () => number = Math.random
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  call.ringGroupId = groupId;
  const group = snapshot.ringGroups.find(
    row => row.id === groupId && row.deletedAt === null
  );
  if (group === undefined) {
    await release(pipeline, call, RELEASE_CODE_UNAVAILABLE, 'failed');
    return;
  }
  // §7: the ring group's diagnostics override counts toward the call's level.
  raiseLogLevel(call.log, group, pipeline.deps.now());
  const groupInfo = {
    mailboxEnabled: group.mailboxEnabled === 1,
    ringGroupId: groupId
  };
  const rules = buildGroupRules(snapshot, groupId);
  // Only a group that rings busy members needs to know which of their devices is the busy one.
  const busy =
    group.skipBusy === 1 ? new Set<string>() : await busyDevices(pipeline);
  const members = buildMemberStates(
    pipeline,
    snapshot,
    groupId,
    pipeline.deps.now(),
    busy
  );
  const legs = ringable(members, group.skipBusy === 1);

  if (legs.length === 0) {
    call.log.event({ event: 'ringGroup', groupId, result: 'unavailable' });
    await applyGroupFallback(pipeline, call, groupInfo, rules, 'unavailable');
    return;
  }

  await playGreetingAndMoh(pipeline, call, groupId, snapshot, group);
  if (callEnded(call)) {
    // The caller's own channel ended during the greeting or MoH start: legs.ts's
    // `handleChannelEnded` → `endAbandonedCall` already finished the call (§10.1 "Call
    // aggregate"), so no batch is originated and no fallback runs on the destroyed channel.
    return;
  }

  const plan = ringPlan(
    legs,
    group.strategy as Strategy,
    group.ringTimeoutS,
    group.ringTotalS,
    rng
  );

  // §9.3 "a ring group: RINGING while the group rings, else NOT_INUSE".
  const groupExt = extensionOf(snapshot, { ringGroupId: groupId });
  if (groupExt !== null) {
    await pipeline.deps.presence?.setHint(groupExt, 'RINGING');
  }
  try {
    await runBatchPlan(pipeline, call, plan, {
      groupId,
      snapshot,
      group,
      groupInfo,
      rules
    });
  } finally {
    if (groupExt !== null) {
      await pipeline.deps.presence?.setHint(groupExt, 'NOT_INUSE');
    }
  }
}
