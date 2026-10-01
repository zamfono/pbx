import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { liveUser, toUserOut } from './_shared.js';

const STATUS_FORBIDDEN = 403;

/** `GET /users/{id}` (§10.3): a `user` actor reads only their own profile (§5.3). */
export const get = defineOperation({
  name: 'users.get',
  description: 'Reads one live user by id.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    if (ctx.actor.role === 'user' && ctx.actor.id !== input.id) {
      throw new OpError(
        STATUS_FORBIDDEN,
        'users: may read only your own profile'
      );
    }
    const row = await liveUser(ctx.db, input.id);
    return toUserOut(ctx.db, row);
  }
});
