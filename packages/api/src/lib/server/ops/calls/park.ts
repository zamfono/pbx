import { z } from 'zod';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation } from '../types.js';
import {
  CALL_ACTION_PROBLEMS,
  callActionOutput,
  legIdInput,
  liveCallIdInput,
  ownLiveCall,
  requireLegOrPresence
} from './_shared.js';

const inputSchema = z
  .object({
    id: liveCallIdInput,
    legId: legIdInput(
      'that is parked; the other side is the parker, whose user the ring-back rings'
    )
  })
  .strict();

/**
 * `POST /calls/{id}/park` (§10.2 "Call parking", §5.7): parks the other party of the live call
 * `id` as `*70` does, proxied to `core`: the party waits on the lowest free slot with the hold
 * music, the parker's own leg is hung up, and the parker is rung back on timeout. No phone hears
 * the slot read out, so it is the result. Recorded with the acting user in the call's own history
 * entry rather than the audit log.
 */
export const park = defineOperation({
  name: 'calls.park',
  description:
    'Parks the other party of a live call on the lowest free parking slot, as *70 does, and returns the slot; anyone retrieves it by dialling the slot (calls.originate with the slot as target).',
  input: inputSchema,
  output: callActionOutput.extend({
    slot: z
      .string()
      .describe(
        'The parking slot the call waits on; dial it to retrieve the call.'
      )
  }),
  problems: CALL_ACTION_PROBLEMS,
  minRole: 'user',
  scope: ownLiveCall,
  audit: false,
  writesDatabase: false,
  run: async (ctx, input) => {
    await requireLegOrPresence(ctx, input);
    const { slot } = await getCoreClient().park(input.id, {
      userId: ctx.actor.id,
      actorUserId: ctx.actor.id,
      ...(input.legId === undefined ? {} : { legId: input.legId })
    });
    return { id: input.id, slot };
  }
});
