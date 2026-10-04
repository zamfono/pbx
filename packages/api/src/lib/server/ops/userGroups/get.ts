import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { defineOperation } from '../types.js';
import { liveUserGroup, toUserGroupOut, userGroupOut } from './_shared.js';

export const getUserGroup = defineOperation({
  name: 'userGroups.get',
  description: 'Reads one live user group by id.',
  input: z.object({ id: z.string() }).strict(),
  output: userGroupOut,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveUserGroup(ctx.db, input.id);
    return toUserGroupOut(ctx.db, row);
  }
});
