/**
 * What routing pipeline step 5, "Target ring group" (§10.1), decides on: the group's members
 * flattened into the `MemberState`s `ringable` expects — DND, registration, in a call, OOO and
 * an unconditional forward — and its `ring_group_forward_rules`, for `ringGroup.ts`.
 */
import { userById, type Snapshot } from '../internal/snapshot.js';
import type { DecisionInputs } from '../routing/decision.js';
import { resolvePure } from '../routing/resolvePure.js';
import type { MemberState } from '../routing/ringGroup.js';
import { ownInEffectOoo } from '../routing/schedule.js';
import { buildOooRules } from '../routing/scheduleRows.js';
import {
  buildUserRules,
  findForwardTarget,
  type ForwardTarget
} from '../routing/targets.js';
import { groupMemberUserIds } from './extensionOwner.js';
import type { Pipeline } from './pipeline.js';
import { isUserInCall, registeredDevices } from './userDevices.js';

export type GroupOutcome = 'unanswered' | 'unavailable';
export type GroupRules = Partial<Record<GroupOutcome, ForwardTarget>>;

/** `ring_group_members`, flattened through `groupMemberUserIds`, as the `MemberState[]` `ringable` (§10.1 step 5) expects;
 * `busy` holds the devices carrying a call (`busyDevices`), `hops` the forward hops the call has
 * taken (`Call.hops`), `inputs` what a decision a member's forward reaches reads. */
export function buildMemberStates(
  pipeline: Pipeline,
  snapshot: Snapshot,
  groupId: string,
  at: {
    now: string;
    busy: ReadonlySet<string>;
    hops: number;
    inputs: DecisionInputs;
  }
): MemberState[] {
  const { now, busy } = at;
  const userIds = groupMemberUserIds(snapshot, groupId);
  const oooRules = buildOooRules(snapshot.oooRules);
  return userIds.map(userId => {
    const rule = buildUserRules(snapshot, userId).unconditional ?? null;
    // A forward is resolved through its decisions and the own DIDs it names (§10.1 Outbound
    // step 5) to the target the member's leg rings, each member's chain on its own, up to the hop
    // limit or a decision met again (step 7).
    const followed =
      rule === null ? null : resolvePure(snapshot, rule, at.hops, at.inputs);
    const unconditional = followed?.target ?? rule;
    const devices = registeredDevices(pipeline, snapshot, userId);
    return {
      userId,
      dnd: userById(snapshot, userId)?.dnd === 1,
      registeredDevices: devices.length,
      inCall: isUserInCall(pipeline, userId),
      idleDevices: devices.filter(device => !busy.has(device.sipUsername))
        .length,
      oooInEffect: ownInEffectOoo(oooRules, `user:${userId}`, now) !== null,
      unconditional,
      ...(rule !== null && followed === null ? { forwardHopLimit: true } : {}),
      forwardRegisteredDevices:
        unconditional?.kind === 'user'
          ? registeredDevices(pipeline, snapshot, unconditional.userId).length
          : 0
    };
  });
}

/** `ring_group_forward_rules` for `groupId`, resolved to their `ForwardTarget`s. */
export function buildGroupRules(
  snapshot: Snapshot,
  groupId: string
): GroupRules {
  const rules: GroupRules = {};
  for (const row of snapshot.ringGroupForwardRules) {
    if (row.groupId !== groupId) {
      continue;
    }
    rules[row.condition] = findForwardTarget(snapshot, row.targetId);
  }
  return rules;
}
