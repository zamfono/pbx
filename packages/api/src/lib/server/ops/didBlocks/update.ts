import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { recordChange, recordFieldChanges } from '../audit.js';
import { writeTarget } from '../forwardTargets.js';
import { type TargetSpec } from '../forwardTargetSchema.js';
import { resolveOptionalTarget } from '../forwardTargetSpec.js';
import { deleteForwardTargets } from '../forwardTargetWrite.js';
import { orBefore } from '../patch.js';
import { propagate } from '../propagate.js';
import { defineOperation, type Context } from '../types.js';
import {
  didBlockOut,
  DIGITS_SCHEMA,
  FALLBACK_TARGET_SCHEMA,
  liveDidBlock
} from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable().optional(),
    digits: DIGITS_SCHEMA,
    fallbackTarget: FALLBACK_TARGET_SCHEMA
  })
  .strict();

/**
 * The block's next `fallback_target_id`: unchanged while `fallbackTarget` is absent, cleared on
 * `null`, the caller deleting the row once the block no longer names it, else the block's own
 * forward-target row written in place, or a new one where it has none (§11.2, §11.3).
 */
async function resolveFallbackTargetId(
  ctx: Context,
  before: string | null,
  fallbackTarget: TargetSpec | null | undefined
): Promise<string | null> {
  if (fallbackTarget === undefined) {
    return before;
  }
  if (fallbackTarget === null) {
    return null;
  }
  return writeTarget(ctx, fallbackTarget, before);
}

/**
 * `PATCH /didBlocks/{id}` (§10.3 "Extensions & DIDs"): label, digit count and fallback target are
 * editable; `base` is immutable, since the DIDs inside are matched by it.
 */
export const update = defineOperation({
  name: 'didBlocks.update',
  description:
    "Changes a number block's label, digit count or fallback target; the base is immutable",
  input: inputSchema,
  output: didBlockOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  entity: input => ({ kind: 'didBlock', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveDidBlock(ctx.db, input.id);
    const label = orBefore(input.label, before.label);
    const digits = orBefore(input.digits, before.digits);
    // Read before the write, which changes the row in place.
    const previous = await resolveOptionalTarget(
      ctx.db,
      before.fallbackTargetId
    );
    const fallbackTargetId = await resolveFallbackTargetId(
      ctx,
      before.fallbackTargetId,
      input.fallbackTarget
    );
    recordFieldChanges(ctx, before, { label, digits });
    if (input.fallbackTarget !== undefined) {
      // The diff names this operation's own input field and carries the wire target, so
      // `audit.undo` replays it straight back through `didBlocks.update` (§5.8).
      recordChange(ctx, {
        field: 'fallbackTarget',
        from: previous,
        to: input.fallbackTarget
      });
    }
    await ctx.db
      .updateTable('didBlocks')
      .set({ label, digits, fallbackTargetId })
      .where('id', '=', input.id)
      .execute();
    if (fallbackTargetId === null && before.fallbackTargetId !== null) {
      await deleteForwardTargets(ctx.db, [before.fallbackTargetId]);
    }
    const fallbackTarget =
      input.fallbackTarget === undefined
        ? await resolveOptionalTarget(ctx.db, fallbackTargetId)
        : input.fallbackTarget;
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return {
      id: before.id,
      base: before.base,
      label,
      digits,
      fallbackTarget,
      createdAt: before.createdAt
    };
  }
});
