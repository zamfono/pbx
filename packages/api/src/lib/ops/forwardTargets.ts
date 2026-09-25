import { findForwardTargetOwners } from './forwardTargetOwners.js';
import {
  insertForwardTarget,
  targetSpecSchema,
  type TargetSpec
} from './forwardTargetSpec.js';
import type { Context } from './types.js';

// `TargetSpec` (§11.2 `forward_targets`) is the wire union every area that owns a forwarding
// rule, fallback or menu option accepts and returns; `targetSpecSchema` already validates it,
// `external` as E.164, so this module reuses both rather than re-deriving them.
export { targetSpecSchema as targetInputSchema };
export type TargetInput = TargetSpec;

/**
 * Inserts a `forward_targets` row for `input`, owned by the caller's rule, and returns its id;
 * 404s when `input` points at a row that is not live (§5.9).
 */
export async function createTarget(
  ctx: Context,
  input: TargetInput
): Promise<string> {
  return insertForwardTarget(ctx.db, input);
}

/** The `forward_targets` columns a target's owner sets; every other owner column is NULL. */
type TargetRow = {
  userId: string | null;
  ringGroupId: string | null;
  external: string | null;
  mailboxUserId: string | null;
  mailboxRingGroupId: string | null;
  announcementAudioId: string | null;
  menuId: string | null;
};

/** The wire shape of a `forward_targets` row, the inverse of `createTarget`'s column mapping. */
export function targetToWire(row: TargetRow): TargetInput {
  if (row.userId !== null) {
    return { kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  if (row.external !== null) {
    return { kind: 'external', external: row.external };
  }
  if (row.mailboxUserId !== null) {
    return { kind: 'mailboxUser', userId: row.mailboxUserId };
  }
  if (row.mailboxRingGroupId !== null) {
    return { kind: 'mailboxRingGroup', ringGroupId: row.mailboxRingGroupId };
  }
  if (row.announcementAudioId !== null) {
    return { kind: 'announcement', audioId: row.announcementAudioId };
  }
  if (row.menuId !== null) {
    return { kind: 'menu', menuId: row.menuId };
  }
  throw new Error('forwardTargets: row has no owner column set');
}

/**
 * Deletes a `forward_targets` row once no owner column references it any more (§5.9, §11.2): the
 * caller deletes its own owning row first, so this only ever finds a reference genuinely left by
 * another entity.
 */
export async function deleteTargetIfOrphan(
  ctx: Context,
  id: string
): Promise<void> {
  const owners = await findForwardTargetOwners(ctx.db, [id]);
  if (owners.length === 0) {
    await ctx.db.deleteFrom('forwardTargets').where('id', '=', id).execute();
  }
}
