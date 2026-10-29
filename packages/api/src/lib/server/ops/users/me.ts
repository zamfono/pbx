import { z } from 'zod';

import { defineOperation } from '../types.js';
import { liveUser, toUserOut, userOut } from './_shared.js';

/** `GET /users/me` (§10.3): the caller's own profile, whoever their credential acts as (§5.2). */
export const me = defineOperation({
  name: 'users.me',
  description:
    'Reads the user the caller acts as, e.g. to check whose personal access token is in use.',
  input: z.object({}).strict(),
  output: userOut,
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async ctx => toUserOut(ctx.db, await liveUser(ctx.db, ctx.actor.id))
});
