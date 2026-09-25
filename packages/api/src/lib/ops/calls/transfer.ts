import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  assertOwnLiveCall,
  getCoreClient,
  proxyCallAction
} from './_shared.js';

const inputSchema = z
  .object({ id: z.string(), target: z.string().min(1) })
  .strict();

/**
 * `POST /calls/{id}/transfer` (§10.1 "Transfers and pickup", §5.7): blind-transfers the live
 * call `id` to `target`, proxied to `core`; recorded with the acting user in the call's own
 * history entry rather than the audit log.
 */
export const transfer = defineOperation({
  name: 'calls.transfer',
  description: 'Blind-transfers a live call to another target.',
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    await assertOwnLiveCall(ctx, input.id);
    await proxyCallAction(() =>
      getCoreClient().transfer(input.id, {
        target: input.target,
        actorUserId: ctx.actor.id
      })
    );
    return { id: input.id };
  }
});
