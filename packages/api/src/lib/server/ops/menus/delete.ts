import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, OpError } from '../types.js';
import { findMenuReferences } from './_references.js';

const STATUS_NOT_FOUND = 404;

export const deleteMenu = defineOperation({
  name: 'menus.delete',
  description: 'Soft-deletes a menu.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: input =>
    `Delete this menu? The deletion can be undone for 30 days. (${input.id})`,
  entity: input => ({ kind: 'menu', id: input.id }),
  run: async (ctx, input) => {
    const before = await ctx.db
      .selectFrom('menus')
      .select('id')
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!before) {
      throw new OpError(STATUS_NOT_FOUND, `menu '${input.id}' not found`);
    }
    const references = await findMenuReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('menu is still in use', references);
    }
    await ctx.db
      .updateTable('menus')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
