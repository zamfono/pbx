import { z } from 'zod';

import { softDelete } from '../rows.js';
import { propagate } from '../runner.js';
import { Conflict, defineOperation } from '../types.js';
import { findMenuReferences } from './_references.js';
import { liveMenu } from './_shared.js';

export const deleteMenu = defineOperation({
  name: 'menus.delete',
  description: 'Soft-deletes a menu.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: input =>
    `Delete this menu? The deletion can be undone for 30 days. (${input.id})`,
  entity: input => ({ kind: 'menu', id: input.id }),
  run: async (ctx, input) => {
    await liveMenu(ctx.db, input.id);
    const references = await findMenuReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('menu is still in use', references);
    }
    await softDelete(ctx, 'menus', input.id);
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
