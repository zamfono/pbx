import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';
import {
  CALL_ACTION_PROBLEMS,
  callActionOutput,
  liveCallIdInput
} from './_shared.js';

const inputSchema = z.object({ id: liveCallIdInput }).strict();

/**
 * `POST /calls/{id}/pickup` (§10.1 "Transfers and pickup", §5.7): the caller picks up the ringing
 * call `id` on their own phones, proxied to `core`; recorded in the call's own history entry
 * rather than the audit log.
 */
export const pickup = defineOperation({
  name: 'calls.pickup',
  description:
    "Picks up a call ringing for another party, on the picking user's devices.",
  input: inputSchema,
  output: callActionOutput,
  problems: CALL_ACTION_PROBLEMS,
  minRole: 'user',
  scope: 'any',
  audit: false,
  writesDatabase: false,
  run: async (ctx, input) => {
    await getCoreClient().pickup(input.id, { actorUserId: ctx.actor.id });
    return { id: input.id };
  }
});
