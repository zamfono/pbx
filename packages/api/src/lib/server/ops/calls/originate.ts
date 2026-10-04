import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';
import { proxyCallAction, resolveActingUserId } from './_shared.js';

const inputSchema = z
  .object({
    target: z
      .string()
      .min(1)
      .describe(
        'What to dial once a device answers, as that device would: an extension or a number, E.164 or national.'
      ),
    userId: z
      .string()
      .optional()
      .describe(
        'The user whose devices ring first; left out, the caller themselves (admins only for another user).'
      ),
    clir: z
      .boolean()
      .optional()
      .describe(
        "This call's own CLIR: true withholds the number, false presents it, as #31# and *31# do, over the user's, trunk's and tenant's default; an emergency call always presents it. Left out, the default applies."
      )
  })
  .strict();

/**
 * `POST /calls` (§10.2 "Click-to-dial"): rings `userId`'s (or, absent that, the caller's own)
 * devices first, then dials `target` exactly as that device would once one answers, so CLIR,
 * routes, caller-ID and the channel cap all apply, and a parking slot retrieves the call parked
 * there. `clir` is the call's own CLIR, as `#31#`/`*31#` before the target (§9.4). A `user` may
 * originate only for themselves, an admin for any user.
 */
export const originate = defineOperation({
  name: 'calls.originate',
  description:
    "Click-to-dial: rings a user's devices, then dials the target on answer, as that phone would; a parking slot as target retrieves the call parked there.",
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    const userId = resolveActingUserId(ctx, input.userId);
    return proxyCallAction(async () =>
      getCoreClient().originate({
        userId,
        target: input.target,
        actorUserId: ctx.actor.id,
        requestId: ctx.requestId,
        ...(input.clir === undefined ? {} : { clir: input.clir })
      })
    );
  }
});
