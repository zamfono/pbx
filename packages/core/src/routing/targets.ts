/**
 * The shared forward-target vocabulary (spec §11.2 `forward_targets`) and hop counting for
 * routing pipeline step 7, "Forward targets" (§10.1).
 */

export type ForwardTarget = { id: string } & (
  | { kind: 'user'; userId: string }
  | { kind: 'ringGroup'; ringGroupId: string }
  | { kind: 'external'; number: string }
  | { kind: 'sip'; trunkId: string; user: string }
  | { kind: 'mailboxUser'; userId: string }
  | { kind: 'mailboxRingGroup'; ringGroupId: string }
  | { kind: 'announcement'; audioId: string }
  | { kind: 'menu'; menuId: string }
);

/** A `forward_targets` row: exactly one target is set, `sip`'s being its column pair, enforced by
 * the table's CHECK. */
export type ForwardTargetsRow = {
  id: string;
  userId: string | null;
  ringGroupId: string | null;
  external: string | null;
  sipTrunkId: string | null;
  sipUser: string | null;
  mailboxUserId: string | null;
  mailboxRingGroupId: string | null;
  announcementAudioId: string | null;
  menuId: string | null;
};

/** Reads the one set column of `row` into the `ForwardTarget` union it represents. */
export function targetFromRow(row: ForwardTargetsRow): ForwardTarget {
  const { id } = row;
  if (row.userId !== null) {
    return { id, kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { id, kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  if (row.external !== null) {
    return { id, kind: 'external', number: row.external };
  }
  if (row.sipTrunkId !== null && row.sipUser !== null) {
    return { id, kind: 'sip', trunkId: row.sipTrunkId, user: row.sipUser };
  }
  if (row.mailboxUserId !== null) {
    return { id, kind: 'mailboxUser', userId: row.mailboxUserId };
  }
  if (row.mailboxRingGroupId !== null) {
    return {
      id,
      kind: 'mailboxRingGroup',
      ringGroupId: row.mailboxRingGroupId
    };
  }
  if (row.announcementAudioId !== null) {
    return { id, kind: 'announcement', audioId: row.announcementAudioId };
  }
  if (row.menuId !== null) {
    return { id, kind: 'menu', menuId: row.menuId };
  }
  throw new Error(`forwardTargets: row ${id} sets no target column`);
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
