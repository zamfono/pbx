import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  getCoreClient,
  proxyCallAction,
  resolveActingUserId
} from './_shared.js';

const inputSchema = z
  .object({ id: z.string(), userId: z.string().optional() })
  .strict();

/**
 * `POST /calls/{id}/pickup` (§10.1 "Transfers and pickup", §5.7): `userId` (or, absent that, the
 * caller themselves) picks up the ringing call `id`, proxied to `core`; recorded with the acting
 * user in the call's own history entry rather than the audit log.
 */
export const pickup = defineOperation({
  name: 'calls.pickup',
  description: 'Picks up a call ringing for another party.',
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    const userId = resolveActingUserId(ctx, input.userId);
    await proxyCallAction(() =>
      getCoreClient().pickup(input.id, { userId, actorUserId: ctx.actor.id })
    );
    return { id: input.id };
  }
});
