import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { menuTargetRows } from './_shared.js';

const STATUS_NOT_FOUND = 404;

/**
 * `GET /menus/{id}/targets` (§10.3): reads a menu's DTMF map as `{ id, targets }`, the shape
 * `menus.setTargets` takes and returns, so a read, an edit and a `PUT` round-trip unchanged.
 */
export const getMenuTargets = defineOperation({
  name: 'menus.getTargets',
  description: "Reads a menu's DTMF-to-target map.",
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const menu = await ctx.db
      .selectFrom('menus')
      .select('id')
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!menu) {
      throw new OpError(STATUS_NOT_FOUND, `menu '${input.id}' not found`);
    }
    return { id: input.id, targets: await menuTargetRows(ctx.db, input.id) };
  }
});
