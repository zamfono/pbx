import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { toUserGroupOut } from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const getUserGroup = defineOperation({
  name: 'userGroups.get',
  description: 'Reads one live user group by id.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom('userGroups')
      .selectAll()
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, `user group '${input.id}' not found`);
    }
    return toUserGroupOut(ctx.db, row);
  }
});
