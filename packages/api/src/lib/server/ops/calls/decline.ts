import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';
import { proxyCallAction } from './_shared.js';

const inputSchema = z
  .object({
    id: z
      .string()
      .describe("The ringing call's id, as calls.list with live=true lists it.")
  })
  .strict();

/**
 * `POST /calls/{id}/decline` (§10.1 steps 4 and 5, §10.3 "Live calls"): the caller's own legs
 * ringing for the call `id` end as their phones' decline ends them, proxied to `core`, which
 * refuses with 409 `notRinging` when none rings. Always the caller's own ring, never another
 * user's, so it needs no check here. Recorded in the call's own history entry rather than the
 * audit log.
 */
export const decline = defineOperation({
  name: 'calls.decline',
  description:
    'Declines a call ringing for you, as declining it on your phone would: your phones stop ringing, and the call goes on to your no-answer rule, or a ring group rings its other members.',
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    await proxyCallAction(() =>
      getCoreClient().decline(input.id, { actorUserId: ctx.actor.id })
    );
    return { id: input.id };
  }
});
