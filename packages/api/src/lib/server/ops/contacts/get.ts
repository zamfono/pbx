import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { toContactOut } from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const getContact = defineOperation({
  name: 'contacts.get',
  description: 'Reads one live contact by id.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom('contacts')
      .selectAll()
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, `contact '${input.id}' not found`);
    }
    return toContactOut(ctx.db, row);
  }
});
