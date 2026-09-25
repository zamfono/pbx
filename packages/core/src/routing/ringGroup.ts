/**
 * Routing pipeline step 5, "Target ring group" (spec §10.1): member expansion (§11.2
 * `ring_group_members`, `user_group_users`, `user_group_groups`), ringability, the per-strategy
 * ring plan and the group's fallback (§11.2 `ring_group_forward_rules`).
 */

import type { ForwardTarget } from './targets.js';

type MemberRow = {
  position: number;
  userId: string | null;
  userGroupId: string | null;
};

/** Shared read-only lookups threaded through member expansion, kept off the call stack as one object. */
type ExpansionCtx = {
  userGroupUsers: Map<string, string[]>;
  userGroupGroups: Map<string, string[]>;
  liveUserIds: Set<string>;
  seen: Set<string>;
};

/** Appends `userId` to `result` unless already collected or soft-deleted. */
function addUser(userId: string, ctx: ExpansionCtx, result: string[]): void {
  if (ctx.seen.has(userId) || !ctx.liveUserIds.has(userId)) {
    return;
  }
  ctx.seen.add(userId);
  result.push(userId);
}

/**
 * Flattens `userGroupId`'s direct users, then its nested groups depth-first; `visited` guards
 * against a cycle, defensively, since `user_group_groups_no_cycle` already rejects one on write.
 */
function collectGroupUsers(
  userGroupId: string,
  ctx: ExpansionCtx,
  visited: Set<string>,
  result: string[]
): void {
  if (visited.has(userGroupId)) {
    return;
  }
  visited.add(userGroupId);
  for (const userId of ctx.userGroupUsers.get(userGroupId) ?? []) {
    addUser(userId, ctx, result);
  }
  for (const childGroupId of ctx.userGroupGroups.get(userGroupId) ?? []) {
    collectGroupUsers(childGroupId, ctx, visited, result);
  }
}

/**
 * The group's member users in ring order: `members` sorted by `position`, each user row taken
 * directly and each user-group row flattened through `userGroupUsers`/`userGroupGroups`, nested
 * groups included, duplicates and soft-deleted users (absent from `liveUserIds`) dropped (§10.1
 * step 5, §11.2).
 */
export function expandMembers(
  groupId: string,
  members: MemberRow[],
  userGroupUsers: Map<string, string[]>,
  userGroupGroups: Map<string, string[]>,
  liveUserIds: Set<string>
): string[] {
  const ctx: ExpansionCtx = {
    userGroupUsers,
    userGroupGroups,
    liveUserIds,
    seen: new Set()
  };
  const result: string[] = [];
  const ordered = [...members].sort(
    (left, right) => left.position - right.position
  );
  for (const member of ordered) {
    if (member.userId !== null) {
      addUser(member.userId, ctx, result);
    } else if (member.userGroupId !== null) {
      collectGroupUsers(member.userGroupId, ctx, new Set(), result);
    }
  }
  return result;
}

export type MemberState = {
  userId: string;
  dnd: boolean;
  registeredDevices: number;
  inCall: boolean;
  /** Of `registeredDevices`, those not carrying the call `inCall` reports. */
  idleDevices: number;
  oooInEffect: boolean;
  unconditional: ForwardTarget | null;
  /** The registered devices of `unconditional`'s user, when it forwards to a user; 0 otherwise. */
  forwardRegisteredDevices: number;
};

export type MemberLeg =
  | { userId: string; via: 'devices' }
  | { userId: string; via: 'forward'; target: ForwardTarget };

/**
 * The legs a group actually rings, in member order (§10.1 step 5): DND, offline (no registered
 * device) or an in-effect OOO rule skips the member, and one already in a call is skipped while
 * `skipBusy`, or without another registered device to ring. Of the rest, an unconditional forward to a user who has a registered device, or to
 * an external number, is followed as the member's leg; any other unconditional target skips the
 * member, so a group never drops its caller into one member's voicemail, and a forward to a user
 * with nothing to ring rings nothing.
 */
export function ringable(
  members: MemberState[],
  skipBusy: boolean
): MemberLeg[] {
  const legs: MemberLeg[] = [];
  for (const member of members) {
    if (member.dnd || member.oooInEffect || member.registeredDevices === 0) {
      continue;
    }
    // With `skipBusy` cleared a busy member rings on their other devices, if they have any.
    if (member.inCall && (skipBusy || member.idleDevices === 0)) {
      continue;
    }
    const forward = member.unconditional;
    if (forward === null) {
      legs.push({ userId: member.userId, via: 'devices' });
      continue;
    }
    const followed =
      forward.kind === 'external' ||
      (forward.kind === 'user' && member.forwardRegisteredDevices > 0);
    if (followed) {
      legs.push({ userId: member.userId, via: 'forward', target: forward });
    }
  }
  return legs;
}

export type Strategy = 'simultaneous' | 'sequential' | 'random';

/** A Fisher-Yates shuffle driven by the injected `rng` (`[0, 1)`), for a deterministic `random` plan. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    const current = shuffled[index];
    const swapped = shuffled[swapIndex];
    // `swapIndex` is in `[0, index]` and `index < shuffled.length`, so both are always present.
    if (current === undefined || swapped === undefined) {
      throw new Error('shuffle: index out of bounds');
    }
    shuffled[index] = swapped;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

/**
 * The ring batches for `legs`: `simultaneous` rings all of them once for `ringTimeoutS`;
 * `sequential` and `random` (over a `rng`-shuffled order) ring one member at a time for
 * `ringTimeoutS` each, the cumulative time capped by `ringTotalS` (`null` = uncapped); a member
 * that would start after the cap is reached is dropped (§10.1 step 5).
 */
export function ringPlan(
  legs: MemberLeg[],
  strategy: Strategy,
  ringTimeoutS: number,
  ringTotalS: number | null,
  rng: () => number
): { legs: MemberLeg[]; timeoutS: number }[] {
  if (strategy === 'simultaneous') {
    return legs.length > 0 ? [{ legs, timeoutS: ringTimeoutS }] : [];
  }
  const ordered = strategy === 'random' ? shuffle(legs, rng) : legs;
  const plan: { legs: MemberLeg[]; timeoutS: number }[] = [];
  let remainingS = ringTotalS ?? Infinity;
  for (const leg of ordered) {
    if (remainingS <= 0) {
      break;
    }
    const timeoutS = Math.min(ringTimeoutS, remainingS);
    plan.push({ legs: [leg], timeoutS });
    remainingS -= timeoutS;
  }
  return plan;
}

/** The release status of the group step's implicit default (§10.1 step 5). */

const RELEASE_CODE_UNAVAILABLE = 480;

/**
 * The fallback once ringing ends without an answer: the matching rule, or for `unavailable` the
 * `unanswered` rule when `unavailable` is absent; else the implicit default, the group's own
 * mailbox when enabled, otherwise 480 (§10.1 step 5, §11.2 `ring_group_forward_rules`).
 */
export function groupFallback(
  group: { mailboxEnabled: boolean; ringGroupId: string },
  rules: Partial<Record<'unanswered' | 'unavailable', ForwardTarget>>,
  outcome: 'unanswered' | 'unavailable'
):
  | { kind: 'forward'; target: ForwardTarget }
  | { kind: 'mailbox'; ringGroupId: string }
  // eslint-disable-next-line no-magic-numbers -- the SIP release code of the group step's implicit default (§10.1)
  | { kind: 'release'; code: 480 } {
  const target =
    rules[outcome] ??
    (outcome === 'unavailable' ? rules.unanswered : undefined);
  if (target) {
    return { kind: 'forward', target };
  }
  if (group.mailboxEnabled) {
    return { kind: 'mailbox', ringGroupId: group.ringGroupId };
  }
  return { kind: 'release', code: RELEASE_CODE_UNAVAILABLE };
}
