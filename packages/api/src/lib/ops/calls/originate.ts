import { z } from 'zod';

import { defineOperation, OpError } from '../types.js';
import { getCoreClient, resolveActingUserId } from './_shared.js';

const STATUS_CONFLICT = 409;

const inputSchema = z
  .object({ target: z.string().min(1), userId: z.string().optional() })
  .strict();

/**
 * `POST /calls` (§10.2 "Click-to-dial"): rings `userId`'s (or, absent that, the caller's own)
 * devices first, then dials `target` exactly as that device would once one answers, so CLIR,
 * routes, caller-ID and the channel cap all apply. A `user` may originate only for themselves, an
 * admin for any user.
 */
export const originate = defineOperation({
  name: 'calls.originate',
  description:
    "Click-to-dial: rings a user's devices, then dials the target on answer.",
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    const userId = resolveActingUserId(ctx, input.userId);
    const outcome = await getCoreClient().originate({
      userId,
      target: input.target,
      actorUserId: ctx.actor.id,
      requestId: ctx.requestId
    });
    if ('error' in outcome) {
      // A string `detail` is the problem's own RFC 9457 member, which names the cause (§10.2).
      throw new OpError(
        STATUS_CONFLICT,
        'no device is registered for this user',
        outcome.error
      );
    }
    return outcome;
  }
});
