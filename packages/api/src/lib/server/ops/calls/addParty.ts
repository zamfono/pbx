import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';
import {
  CALL_ACTION_PROBLEMS,
  dialledCallOutput,
  dialTargetInput,
  liveCallIdInput,
  ownLiveCall
} from './_shared.js';

const inputSchema = z
  .object({
    id: liveCallIdInput,
    target: dialTargetInput('add')
  })
  .strict();

/**
 * `POST /calls/{id}/parties` (§10.2 "Three-way calls", §10.3 "Live calls"): `*5<target>` over
 * the API, proxied to `core`: `target` is dialled from the actor and, on answer, joins the live
 * call `id`'s bridge as its own `calls` row. Recorded with the acting user in the call's own
 * history entry rather than the audit log.
 */
export const addParty = defineOperation({
  name: 'calls.addParty',
  description:
    "Three-way call: dials the target from you and, once answered, adds them to a live call so all three talk; returns the added party's own call id (callId). It only rings the target: no forward or mailbox of theirs applies.",
  input: inputSchema,
  output: dialledCallOutput,
  problems: CALL_ACTION_PROBLEMS,
  minRole: 'user',
  scope: ownLiveCall,
  audit: false,
  writesDatabase: false,
  run: async (ctx, input) => {
    const { callId } = await getCoreClient().addParty(input.id, {
      target: input.target,
      actorUserId: ctx.actor.id
    });
    return { id: input.id, callId };
  }
});
