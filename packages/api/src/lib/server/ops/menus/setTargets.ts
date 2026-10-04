import { HTTP_NOT_FOUND, HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import {
  deleteForwardTarget,
  insertForwardTarget,
  rowToTarget
} from '../forwardTargetSpec.js';
import { propagate } from '../propagate.js';
import { defineOperation, OpError } from '../types.js';
import { liveMenu, menuTargetsSchema } from './_shared.js';

/** `PUT /menus/{id}/targets` (§10.3): replaces a menu's DTMF map as a whole. */
export const setMenuTargets = defineOperation({
  name: 'menus.setTargets',
  description: "Replaces a menu's DTMF-to-target map as a whole.",
  input: menuTargetsSchema,
  output: menuTargetsSchema,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  entity: input => ({ kind: 'menu', id: input.id }),
  run: async (ctx, input) => {
    await liveMenu(ctx.db, input.id);
    const seenDigits = new Set<string>();
    for (const target of input.targets) {
      if (seenDigits.has(target.digits)) {
        throw new OpError(
          HTTP_UNPROCESSABLE_CONTENT,
          `menus: duplicate target digits '${target.digits}'`
        );
      }
      seenDigits.add(target.digits);
    }
    const existing = await ctx.db
      .selectFrom('menuTargets')
      .select(['digits', 'targetId'])
      .where('menuId', '=', input.id)
      .execute();
    // Resolved before the delete below, since `forwardTargets` rows are gone once it runs.
    const existingTargets = await Promise.all(
      existing.map(async row => ({
        digits: row.digits,
        target: rowToTarget(
          await ctx.db
            .selectFrom('forwardTargets')
            .selectAll()
            .where('id', '=', row.targetId)
            .executeTakeFirstOrThrow()
        )
      }))
    );
    await ctx.db
      .deleteFrom('menuTargets')
      .where('menuId', '=', input.id)
      .execute();
    for (const row of existing) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; deletes must serialize
      await deleteForwardTarget(ctx.db, row.targetId);
    }
    const rows: { menuId: string; digits: string; targetId: string }[] = [];
    for (const option of input.targets) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; inserts must serialize
      const targetId = await insertForwardTarget(ctx, option.target);
      rows.push({ menuId: input.id, digits: option.digits, targetId });
    }
    if (rows.length > 0) {
      await ctx.db.insertInto('menuTargets').values(rows).execute();
    }
    // Recorded in this operation's own input shape, so `audit.undo` replays `from` through it as
    // one replace (§5.8).
    recordChange(ctx, {
      field: 'targets',
      from: existingTargets,
      to: input.targets
    });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id, targets: input.targets };
  }
});
