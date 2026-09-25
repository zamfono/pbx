import type { Db } from '@zamfono/shared';

import {
  insertForwardTarget,
  rowToTarget,
  targetSpecSchema,
  type TargetSpec
} from '../forwardTargetSpec.js';
import type { Context } from '../types.js';

/**
 * The union of forward-target kinds a DID, a block's fallback or a rule can point at
 * (§11.2 `forward_targets`), in the wire shape every operation that accepts or returns a target
 * uses. `forwardTargetSpec` holds the one definition of this vocabulary, its validation and its
 * column mapping.
 */
export const targetInputSchema = targetSpecSchema;

export type TargetInput = TargetSpec;

/**
 * Inserts a `forward_targets` row for `input` and returns its id, after checking that the row it
 * references is live (§5.9): a target pointing at a soft-deleted user, ring group, menu or audio
 * asset would block that row's hard purge on its `RESTRICT` FK (§11.1).
 */
export async function createTarget(
  ctx: Context,
  input: TargetInput
): Promise<string> {
  return insertForwardTarget(ctx.db, input);
}

/** Loads and converts the `forward_targets` row `targetId` points at; `targetId` is never NULL. */
export async function resolveTarget(
  db: Db,
  targetId: string
): Promise<TargetInput> {
  const row = await db
    .selectFrom('forwardTargets')
    .selectAll()
    .where('id', '=', targetId)
    .executeTakeFirstOrThrow();
  return rowToTarget(row);
}

/** `resolveTarget`, but for a nullable FK such as `did_blocks.fallback_target_id`. */
export async function resolveOptionalTarget(
  db: Db,
  targetId: string | null
): Promise<TargetInput | null> {
  return targetId === null ? null : resolveTarget(db, targetId);
}
