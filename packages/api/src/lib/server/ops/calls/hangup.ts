import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';
import {
  CALL_ACTION_PROBLEMS,
  callActionOutput,
  liveCallIdInput,
  ownLiveCall
} from './_shared.js';

const inputSchema = z
  .object({
    id: liveCallIdInput,
    legId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The one leg to hang up, by its id in the call's legs as calls.list with live=true lists them, as its phone hanging up would; left out, the whole call."
      )
  })
  .strict();

/**
 * `POST /calls/{id}/hangup` (§10.1, §5.7): ends the live call `id`, proxied to `core`; recorded
 * with the acting user in the call's own history entry rather than the audit log.
 */
export const hangup = defineOperation({
  name: 'calls.hangup',
  description:
    'Hangs up a live call, or with legId one leg of it, as that phone hanging up would.',
  input: inputSchema,
  output: callActionOutput,
  problems: CALL_ACTION_PROBLEMS,
  minRole: 'user',
  scope: ownLiveCall,
  audit: false,
  writesDatabase: false,
  run: async (ctx, input) => {
    await getCoreClient().hangup(input.id, {
      actorUserId: ctx.actor.id,
      ...(input.legId === undefined ? {} : { legId: input.legId })
    });
    return { id: input.id };
  }
});
