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
 * `POST /calls/{id}/hold` (§10.3 "Live calls"): the other party of the live call `id` hears the
 * tenant's hold music and the actor's media is cut both ways, in `core`, so the actor's phone
 * does not show the hold, and a hold or resume from the phone is a separate matter. Recorded
 * with the acting user in the call's own history entry rather than the audit log.
 */
export const hold = defineOperation({
  name: 'calls.hold',
  description:
    'Puts the other party of a live call on hold: they hear the hold music, and you and they no longer hear each other; calls.resume ends it. The hold happens in the PBX, so the phone does not show it. Hangup, transfer and park work as usual while held.',
  input: inputSchema,
  minRole: 'user',
  scope: ownLiveCall,
  audit: false,
  run: async (ctx, input) => {
    await proxyCallAction(() =>
      getCoreClient().hold(input.id, { actorUserId: ctx.actor.id })
    );
    return { id: input.id };
  }
});
