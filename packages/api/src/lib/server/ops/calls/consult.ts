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
    target: dialTargetInput('consult')
  })
  .strict();

/**
 * `POST /calls/{id}/consult` (§10.1 "Transfers and pickup", §10.3 "Live calls"): the first step
 * of an attended transfer, proxied to `core`: the other party of the live call `id` is held and
 * `target` dialled from the actor, the consultation call `calls.transfer` with `toCallId` then
 * transfers to. Recorded with the acting user in the call's own history entry rather than the
 * audit log.
 */
export const consult = defineOperation({
  name: 'calls.consult',
  description:
    "Starts an attended transfer: puts the other party of a live call on hold with hold music and dials the target from you, returning the consultation call's id (callId) for calls.transfer with toCallId. The hold happens in the PBX, so the phone does not show it.",
  input: inputSchema,
  output: dialledCallOutput,
  problems: CALL_ACTION_PROBLEMS,
  minRole: 'user',
  scope: ownLiveCall,
  audit: false,
  run: async (ctx, input) => {
    const { callId } = await getCoreClient().consult(input.id, {
      target: input.target,
      actorUserId: ctx.actor.id
    });
    return { id: input.id, callId };
  }
});
