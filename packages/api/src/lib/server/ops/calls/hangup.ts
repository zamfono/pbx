import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';
import {
  CALL_ACTION_PROBLEMS,
  callActionOutput,
  liveCallIdInput,
  ownLiveCall
} from './_shared.js';

const inputSchema = z.object({ id: liveCallIdInput }).strict();

/**
 * `POST /calls/{id}/hangup` (§10.1, §5.7): ends the live call `id`, proxied to `core`; recorded
 * with the acting user in the call's own history entry rather than the audit log.
 */
export const hangup = defineOperation({
  name: 'calls.hangup',
  description: 'Hangs up a live call.',
  input: inputSchema,
  output: callActionOutput,
  problems: CALL_ACTION_PROBLEMS,
  minRole: 'user',
  scope: ownLiveCall,
  audit: false,
  writesDatabase: false,
  run: async (ctx, input) => {
    await getCoreClient().hangup(input.id, { actorUserId: ctx.actor.id });
    return { id: input.id };
  }
});
