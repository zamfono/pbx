import { z } from 'zod';

import { defineOperation } from '../types.js';
import { liveUserGroup, toUserGroupOut } from './_shared.js';

export const getUserGroup = defineOperation({
  name: 'userGroups.get',
  description: 'Reads one live user group by id.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveUserGroup(ctx.db, input.id);
    return toUserGroupOut(ctx.db, row);
  }
});
