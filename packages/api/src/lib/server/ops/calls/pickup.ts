import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { ownActingUser } from '../gates.js';
import { defineOperation } from '../types.js';
import { liveCallIdInput, proxyCallAction } from './_shared.js';

const inputSchema = z
  .object({
    id: liveCallIdInput,
    userId: z
      .string()
      .optional()
      .describe(
        'The user whose devices take the call; left out, the caller themselves.'
      )
  })
  .strict();

/**
 * `POST /calls/{id}/pickup` (§10.1 "Transfers and pickup", §5.7): `userId` (or, absent that, the
 * caller themselves) picks up the ringing call `id`, proxied to `core`; recorded with the acting
 * user in the call's own history entry rather than the audit log.
 */
export const pickup = defineOperation({
  name: 'calls.pickup',
  description:
    "Picks up a call ringing for another party, on the picking user's devices.",
  input: inputSchema,
  minRole: 'user',
  scope: ownActingUser,
  audit: false,
  run: async (ctx, input) => {
    const userId = input.userId ?? ctx.actor.id;
    await proxyCallAction(() =>
      getCoreClient().pickup(input.id, { userId, actorUserId: ctx.actor.id })
    );
    return { id: input.id };
  }
});
