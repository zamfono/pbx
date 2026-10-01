import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  assertOwnLiveCall,
  getCallControlClient,
  proxyCallAction
} from './_shared.js';

const inputSchema = z
  .object({
    id: z
      .string()
      .describe("The live call's id, as calls.list with live=true lists it.")
  })
  .strict();

/**
 * `POST /calls/{id}/resume` (§10.3 "Live calls"): the party `calls.hold` or `calls.consult` held
 * returns to the live call `id`'s conversation, in `core`. Recorded with the acting user in the
 * call's own history entry rather than the audit log.
 */
export const resume = defineOperation({
  name: 'calls.resume',
  description:
    'Takes a live call off the hold calls.hold or calls.consult put it on: the held party talks with you again, and during a consultation all three talk. The phone does not show it.',
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    await assertOwnLiveCall(ctx, input.id);
    await proxyCallAction(() =>
      getCallControlClient().resume(input.id, { actorUserId: ctx.actor.id })
    );
    return { id: input.id };
  }
});
