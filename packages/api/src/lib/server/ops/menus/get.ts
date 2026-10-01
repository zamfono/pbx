import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { toMenuOut } from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const getMenu = defineOperation({
  name: 'menus.get',
  description: 'Reads one live menu by id.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom('menus')
      .selectAll()
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, `menu '${input.id}' not found`);
    }
    return toMenuOut(ctx.db, row);
  }
});
