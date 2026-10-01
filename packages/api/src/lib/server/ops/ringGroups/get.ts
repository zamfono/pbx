import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { toRingGroupOut } from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const getRingGroup = defineOperation({
  name: 'ringGroups.get',
  description: 'Reads one live ring group by id.',
  input: z.object({ id: z.string() }),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom('ringGroups')
      .selectAll()
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, `ring group '${input.id}' not found`);
    }
    return toRingGroupOut(ctx.db, row);
  }
});
