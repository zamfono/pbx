import type { Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '@zamfono/shared';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  assertAudioAvailable,
  assertNameAvailable,
  deleteForwardTarget,
  insertForwardTarget,
  MENU_FIELD_DESCRIPTIONS,
  rowToTarget,
  targetSpecSchema,
  toMenuOut,
  type MenuRow
} from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const updateMenuInput = z
  .object({
    id: z.string(),
    name: z.string().min(1).optional(),
    audioId: z.string().optional().describe(MENU_FIELD_DESCRIPTIONS.audioId),
    timeoutS: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(MENU_FIELD_DESCRIPTIONS.timeoutS),
    maxAttempts: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(MENU_FIELD_DESCRIPTIONS.maxAttempts),
    allowExtensionDialing: z
      .boolean()
      .optional()
      .describe(MENU_FIELD_DESCRIPTIONS.allowExtensionDialing),
    fallbackTarget: targetSpecSchema
      .optional()
      .describe(MENU_FIELD_DESCRIPTIONS.fallbackTarget)
  })
  .strict();

async function fetchLive(db: Transaction<DB>, id: string): Promise<MenuRow> {
  const row = await db
    .selectFrom('menus')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(STATUS_NOT_FOUND, `menu '${id}' not found`);
  }
  return row;
}

/** The row's next scalar values: `input`'s value where given, `before`'s own otherwise. */
function resolvedFields(
  before: MenuRow,
  input: z.infer<typeof updateMenuInput>
): Pick<
  MenuRow,
  'name' | 'audioId' | 'timeoutS' | 'maxAttempts' | 'allowExtensionDialing'
> {
  return {
    name: input.name ?? before.name,
    audioId: input.audioId ?? before.audioId,
    timeoutS: input.timeoutS ?? before.timeoutS,
    maxAttempts: input.maxAttempts ?? before.maxAttempts,
    allowExtensionDialing:
      input.allowExtensionDialing === undefined
        ? before.allowExtensionDialing
        : Number(input.allowExtensionDialing)
  };
}

/** `allowExtensionDialing` is stored as 0/1 and taken as a `boolean` (§11.2, §10.3). */
function wireValue(
  field: string,
  value: number | string
): boolean | number | string {
  return field === 'allowExtensionDialing' ? Boolean(value) : value;
}

/** Records each changed column under this operation's own input field name and wire type, so
 * `audit.undo` replays the diff straight back through `menus.update` (§5.8). */
function recordFieldChanges(
  ctx: Context,
  before: MenuRow,
  after: ReturnType<typeof resolvedFields>
): void {
  for (const field of Object.keys(after) as (keyof typeof after)[]) {
    if (after[field] !== before[field]) {
      recordChange(ctx, {
        field,
        from: wireValue(field, before[field]),
        to: wireValue(field, after[field])
      });
    }
  }
}

/**
 * Inserts the menu's new fallback target when `fallbackTarget` is given, returning its id. The
 * old target row is deleted by the caller only after `menus.fallback_target_id` points at the
 * new one, since `forward_targets` rows are `ON DELETE RESTRICT` (§11.2) and the old row is
 * still referenced until that update runs.
 */
async function resolvedFallbackTargetId(
  ctx: Context,
  before: MenuRow,
  fallbackTarget: z.infer<typeof updateMenuInput>['fallbackTarget']
): Promise<string> {
  if (!fallbackTarget) {
    return before.fallbackTargetId;
  }
  const previous = rowToTarget(
    await ctx.db
      .selectFrom('forwardTargets')
      .selectAll()
      .where('id', '=', before.fallbackTargetId)
      .executeTakeFirstOrThrow()
  );
  const newTargetId = await insertForwardTarget(ctx, fallbackTarget);
  // The diff names this operation's own input field and carries the wire target, so `audit.undo`
  // replays it straight back through `menus.update` (§5.8).
  recordChange(ctx, {
    field: 'fallbackTarget',
    from: previous,
    to: fallbackTarget
  });
  return newTargetId;
}

export const updateMenu = defineOperation({
  name: 'menus.update',
  description: "Updates a menu's configuration.",
  input: updateMenuInput,
  minRole: 'admin',
  entity: input => ({ kind: 'menu', id: input.id }),
  run: async (ctx, input) => {
    const before = await fetchLive(ctx.db, input.id);
    if (input.name !== undefined && input.name !== before.name) {
      await assertNameAvailable(ctx.db, input.name, input.id);
    }
    if (input.audioId !== undefined) {
      await assertAudioAvailable(ctx.db, input.audioId);
    }
    const after = resolvedFields(before, input);
    recordFieldChanges(ctx, before, after);
    const fallbackTargetId = await resolvedFallbackTargetId(
      ctx,
      before,
      input.fallbackTarget
    );
    await ctx.db
      .updateTable('menus')
      .set({ ...after, fallbackTargetId })
      .where('id', '=', input.id)
      .execute();
    if (input.fallbackTarget) {
      await deleteForwardTarget(ctx.db, before.fallbackTargetId);
    }
    const row = await ctx.db
      .selectFrom('menus')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return toMenuOut(ctx.db, row);
  }
});
