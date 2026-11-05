/**
 * The shared forward-target vocabulary (spec §11.2 `forward_targets`), its lookups in the config
 * snapshot, and hop counting for routing pipeline step 7, "Forward targets" (§10.1).
 */
import {
  isWebSocketSampleRate,
  type SipHeaderTemplate,
  type UserForwardCondition,
  type WebSocketProtocol,
  type WebSocketSampleRate
} from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';

/** An `external`, `sip` or `webSocket` target's own fallback, where the call goes when it does
 * not work (§10.1 step 7); set only when it has one. */
type Fallback = { fallback?: ForwardTarget };

/** An `external` or `sip` target's ring timeout in seconds (§10.1 step 7); set only when it has one. */
type RingTimeout = { ringTimeoutS?: number };

export type ForwardTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'ringGroup'; ringGroupId: string }
  | ({ kind: 'external'; number: string; record?: true } & RingTimeout &
      Fallback)
  | ({
      kind: 'sip';
      trunkId: string;
      user: string;
      headers: SipHeaderTemplate[];
      record?: true;
    } & RingTimeout &
      Fallback)
  | ({
      kind: 'webSocket';
      protocol: WebSocketProtocol;
      url: string;
      sampleRate: WebSocketSampleRate;
      record?: true;
    } & Fallback)
  | { kind: 'mailboxUser'; userId: string }
  | { kind: 'mailboxRingGroup'; ringGroupId: string }
  | { kind: 'announcement'; audioId: string }
  | { kind: 'menu'; menuId: string };

/** A `forward_targets` row: exactly one target is set, `sip`'s and `webSocket`'s being their
 * column sets, enforced by the table's CHECK, which also allows `record_calls` on an `external`,
 * `sip` or `webSocket` target alone. */
type ForwardTargetsRow = {
  id: string;
  userId: string | null;
  ringGroupId: string | null;
  external: string | null;
  sipTrunkId: string | null;
  sipUser: string | null;
  /** `sip_headers_json` as the config snapshot parses it (§9.4 "Header templates"). */
  sipHeaders: SipHeaderTemplate[] | null;
  webSocketProtocol: WebSocketProtocol | null;
  webSocketUrl: string | null;
  webSocketSampleRate: number | null;
  mailboxUserId: string | null;
  mailboxRingGroupId: string | null;
  announcementAudioId: string | null;
  menuId: string | null;
  ringTimeoutS: number | null;
  /** The target this row is the fallback of (§10.1 step 7), `null` for a chain's first row. */
  fallbackOfId: string | null;
  recordCalls: number;
};

/** An `external`, `sip` or `webSocket` target's `record` (§10.2 "Recording semantics"): set only
 * when it records. */
function recordOf(row: ForwardTargetsRow): { record?: true } {
  return row.recordCalls === 1 ? { record: true } : {};
}

/** An `external` or `sip` target's `ringTimeoutS`: set only when it has one. */
function ringTimeoutOf(row: ForwardTargetsRow): RingTimeout {
  return row.ringTimeoutS === null ? {} : { ringTimeoutS: row.ringTimeoutS };
}

/** A `webSocket` target's sample rate, one of those the table's CHECK allows. */
function sampleRateOf(row: ForwardTargetsRow): WebSocketSampleRate {
  const rate = row.webSocketSampleRate;
  if (isWebSocketSampleRate(rate)) {
    return rate;
  }
  throw new Error(
    `forwardTargets: row ${row.id} has sample rate ${String(rate)}`
  );
}

/** Reads the one set column of `row` into the `ForwardTarget` union it represents, an `external`,
 * `sip` or `webSocket` one with its fallback chain from `rows` (the snapshot's). */
export function targetFromRow(
  row: ForwardTargetsRow,
  rows: readonly ForwardTargetsRow[] = []
): ForwardTarget {
  // The row whose `fallbackOfId` names this one holds its fallback, read down its own chain.
  const next = rows.find(candidate => candidate.fallbackOfId === row.id);
  const fallback: Fallback =
    next === undefined ? {} : { fallback: targetFromRow(next, rows) };
  if (row.userId !== null) {
    return { kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  if (row.external !== null) {
    return {
      kind: 'external',
      number: row.external,
      ...recordOf(row),
      ...ringTimeoutOf(row),
      ...fallback
    };
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
      ...recordOf(row),
      ...ringTimeoutOf(row),
      ...fallback
    };
  }
  // The table's CHECKs set the three `web_socket_*` columns together.
  if (row.webSocketUrl !== null && row.webSocketProtocol !== null) {
    return {
      kind: 'webSocket',
      protocol: row.webSocketProtocol,
      url: row.webSocketUrl,
      sampleRate: sampleRateOf(row),
      ...recordOf(row),
      ...fallback
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
  return targetFromRow(row, snapshot.forwardTargets);
}

/** The tenant's own DID that an `external` target names, by its id, and the DID's target, which
 * the call is routed to internally and never leaves through a trunk (§10.1 Outbound step 5), else
 * `null`. */
export function ownDid(
  snapshot: Snapshot,
  target: ForwardTarget
): { id: string; target: ForwardTarget } | null {
  if (target.kind !== 'external') {
    return null;
  }
  const did = snapshot.dids.find(row => row.number === target.number);
  return did === undefined
    ? null
    : { id: did.id, target: findForwardTarget(snapshot, did.targetId) };
}

/** The target of the own DID that an `external` target names (`ownDid`), else `null`. */
export function ownDidTarget(
  snapshot: Snapshot,
  target: ForwardTarget
): ForwardTarget | null {
  return ownDid(snapshot, target)?.target ?? null;
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
 * Counts one more hop for a `user` or `ringGroup` target re-entering at Entry; a `menu` target
 * re-enters without counting, and every other kind, `external`, `sip` and `webSocket` included,
 * neither counts nor re-enters (§10.1 step 7). `maxHops` is the tenant's hop limit
 * (`settings.max_forward_hops`), past which the last target's mailbox applies instead.
 */
export function nextHop(
  hops: number,
  target: ForwardTarget,
  maxHops: number
): { ok: true; hops: number } | { ok: false } {
  if (target.kind !== 'user' && target.kind !== 'ringGroup') {
    return { ok: true, hops };
  }
  const next = hops + 1;
  if (next > maxHops) {
    return { ok: false };
  }
  return { ok: true, hops: next };
}

/**
 * `target` followed through the tenant's own DIDs it names (`ownDidTarget`) to the target the
 * chain ends at, each DID one hop on the `hops` already taken, as `enterOwnDid` counts them
 * (§10.1 step 7); `null` for a chain that passes the hop limit.
 */
export function throughOwnDids(
  snapshot: Snapshot,
  target: ForwardTarget,
  hops: number
): ForwardTarget | null {
  let current = target;
  let taken = hops;
  for (
    let next = ownDidTarget(snapshot, current);
    next !== null;
    next = ownDidTarget(snapshot, current)
  ) {
    taken += 1;
    if (taken > snapshot.settings.maxForwardHops) {
      return null;
    }
    current = next;
  }
  return current;
}
