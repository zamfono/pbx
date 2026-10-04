import { z } from 'zod';

import { ownUserId } from '../gates.js';
import { defineOperation } from '../types.js';
import { liveUser, toUserOut } from './_shared.js';

/** `GET /users/{id}` (§10.3): a `user` actor reads only their own profile (§5.3). */
export const get = defineOperation({
  name: 'users.get',
  description: 'Reads one live user by id.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  scope: ownUserId,
  readOnly: true,
  run: async (ctx, input) => {
    const row = await liveUser(ctx.db, input.id);
    return toUserOut(ctx.db, row);
  }
});
