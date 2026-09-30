import { findForwardTargetOwners } from './forwardTargetOwners.js';
import {
  insertForwardTarget,
  targetSpecSchema,
  type TargetSpec
} from './forwardTargetSpec.js';
import { OpError, type Context } from './types.js';

const STATUS_FORBIDDEN = 403;

// `TargetSpec` (§11.2 `forward_targets`) is the wire union every area that owns a forwarding
// rule, fallback or menu option accepts and returns; `targetSpecSchema` already validates it,
// `external` as E.164, so this module reuses both rather than re-deriving them.
export { targetSpecSchema as targetInputSchema };
export type TargetInput = TargetSpec;

/**
 * §10.3 "Forward targets": a `sip` target is set or kept by an `admin` or `owner` alone, since it
 * sends calls to whatever host its trunk names (§9.4 "SIP targets"). The one check for every
 * operation a `user` may call, their own forwarding, OOO rules and opening hours: each writes its
 * targets through `createTarget`, and `ooo.update` calls this for the target it keeps. The
 * admin-only operations need it only through `createTarget`, where it always passes.
 */
export function assertMayHoldTarget(ctx: Context, target: TargetInput): void {
  if (target.kind === 'sip' && ctx.actor.role === 'user') {
    throw new OpError(STATUS_FORBIDDEN, 'a sip target is set by an admin');
  }
}

/**
 * Inserts a `forward_targets` row for `input`, owned by the caller's rule, and returns its id;
 * 403s for a `sip` target a `user` may not set, 404s when `input` points at a row that is not
 * live (§5.9).
 */
export async function createTarget(
  ctx: Context,
  input: TargetInput
): Promise<string> {
  assertMayHoldTarget(ctx, input);
  return insertForwardTarget(ctx, input);
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
