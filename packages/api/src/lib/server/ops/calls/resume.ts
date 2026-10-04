import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';
import { liveCallIdInput, ownLiveCall, proxyCallAction } from './_shared.js';

const inputSchema = z
  .object({
    id: liveCallIdInput
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
  scope: ownLiveCall,
  audit: false,
  run: async (ctx, input) => {
    await proxyCallAction(() =>
      getCoreClient().resume(input.id, { actorUserId: ctx.actor.id })
    );
    return { id: input.id };
  }
});
