/**
 * The shared forward-target vocabulary (spec §11.2 `forward_targets`), its lookups in the config
 * snapshot, and hop counting for routing pipeline step 7, "Forward targets" (§10.1).
 */
import type { SipHeaderTemplate, UserForwardCondition } from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';

export type ForwardTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'ringGroup'; ringGroupId: string }
  | { kind: 'external'; number: string; record?: true }
  | {
      kind: 'sip';
      trunkId: string;
      user: string;
      headers: SipHeaderTemplate[];
      record?: true;
    }
  | { kind: 'mailboxUser'; userId: string }
  | { kind: 'mailboxRingGroup'; ringGroupId: string }
  | { kind: 'announcement'; audioId: string }
  | { kind: 'menu'; menuId: string };

/** A `forward_targets` row: exactly one target is set, `sip`'s being its column pair, enforced by
 * the table's CHECK, which also allows `record_calls` on an `external` or `sip` target alone. */
type ForwardTargetsRow = {
  id: string;
  userId: string | null;
  ringGroupId: string | null;
  external: string | null;
  sipTrunkId: string | null;
  sipUser: string | null;
  /** `sip_headers_json` as the config snapshot parses it (§9.4 "Header templates"). */
  sipHeaders: SipHeaderTemplate[] | null;
  mailboxUserId: string | null;
  mailboxRingGroupId: string | null;
  announcementAudioId: string | null;
  menuId: string | null;
  recordCalls: number;
};

/** An `external` or `sip` target's `record` (§10.2 "Recording semantics"): set only when it records. */
function recordOf(row: ForwardTargetsRow): { record?: true } {
  return row.recordCalls === 1 ? { record: true } : {};
}

/** Reads the one set column of `row` into the `ForwardTarget` union it represents. */
export function targetFromRow(row: ForwardTargetsRow): ForwardTarget {
  if (row.userId !== null) {
    return { kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  if (row.external !== null) {
    return { kind: 'external', number: row.external, ...recordOf(row) };
  }
  // The table's CHECKs set `sip_user` and `sip_headers_json` exactly when `sip_trunk_id` is set.
  if (
    row.sipTrunkId !== null &&
    row.sipUser !== null &&
    row.sipHeaders !== null
  ) {
    return {
      kind: 'sip',
      trunkId: row.sipTrunkId,
      user: row.sipUser,
      headers: row.sipHeaders,
      ...recordOf(row)
    };
  }
  if (row.mailboxUserId !== null) {
    return { kind: 'mailboxUser', userId: row.mailboxUserId };
  }
  if (row.mailboxRingGroupId !== null) {
    return {
      kind: 'mailboxRingGroup',
      ringGroupId: row.mailboxRingGroupId
    };
  }
  if (row.announcementAudioId !== null) {
    return { kind: 'announcement', audioId: row.announcementAudioId };
  }
  if (row.menuId !== null) {
    return { kind: 'menu', menuId: row.menuId };
  }
  throw new Error(`forwardTargets: row ${row.id} sets no target column`);
}

/** The `ForwardTarget` a `forward_targets` row represents; throws on a dangling id (FK-guaranteed present). */
export function findForwardTarget(
  snapshot: Snapshot,
  targetId: string
): ForwardTarget {
  const row = snapshot.forwardTargets.find(
    candidate => candidate.id === targetId
  );
  if (!row) {
    throw new Error(`forwardTargets: missing row ${targetId}`);
  }
  return targetFromRow(row);
}

/** The target of the tenant's own DID that an `external` target names, which is routed there
 * internally and never leaves through a trunk (§10.1 Outbound step 5), else `null`. */
export function ownDidTarget(
  snapshot: Snapshot,
  target: ForwardTarget
): ForwardTarget | null {
  if (target.kind !== 'external') {
    return null;
  }
  const did = snapshot.dids.find(row => row.number === target.number);
  return did === undefined ? null : findForwardTarget(snapshot, did.targetId);
}

/** `user_forward_rules` for `userId`, keyed by condition, resolved to their `ForwardTarget`s. */
export function buildUserRules(
  snapshot: Snapshot,
  userId: string
): Partial<Record<UserForwardCondition, ForwardTarget>> {
  const rules: Partial<Record<UserForwardCondition, ForwardTarget>> = {};
  for (const row of snapshot.userForwardRules) {
    if (row.userId !== userId) {
      continue;
    }
    rules[row.condition] = findForwardTarget(snapshot, row.targetId);
  }
  return rules;
}

/**
 * Hops a forward re-entering the pipeline (§10.1 step 7) may make before the last target's
 * mailbox applies instead.
 */
export const MAX_HOPS = 3;

/**
 * Counts one more hop for a `user` or `ringGroup` target re-entering at Entry; a `menu` target
 * re-enters without counting, and every other kind, `external` and `sip` included, neither counts
 * nor re-enters (§10.1 step 7).
 */
export function nextHop(
  hops: number,
  target: ForwardTarget
): { ok: true; hops: number } | { ok: false } {
  if (target.kind !== 'user' && target.kind !== 'ringGroup') {
    return { ok: true, hops };
  }
  const next = hops + 1;
  if (next > MAX_HOPS) {
    return { ok: false };
  }
  return { ok: true, hops: next };
}
