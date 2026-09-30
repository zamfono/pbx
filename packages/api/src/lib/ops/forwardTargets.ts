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
