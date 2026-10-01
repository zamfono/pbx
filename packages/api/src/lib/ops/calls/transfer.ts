import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  assertOwnLiveCall,
  getCoreClient,
  proxyCallAction
} from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    target: z
      .string()
      .min(1)
      .describe(
        'What to dial, as a phone would: an extension, or an external number E.164 or national; with voicemail, the extension whose mailbox takes the call.'
      ),
    voicemail: z
      .boolean()
      .optional()
      .describe(
        'Puts the transferee straight through to the mailbox of the user or ring group owning the target extension, without ringing, as *97<ext> does; 422 noMailbox when nobody owns it.'
      )
  })
  .strict();

/**
 * `POST /calls/{id}/transfer` (§10.1 "Transfers and pickup", §5.7): blind-transfers the live
 * call `id` to `target`, or with `voicemail` to `*97<target>`, its mailbox (§9.3), proxied to
 * `core`; recorded with the acting user in the call's own history entry rather than the audit
 * log.
 */
export const transfer = defineOperation({
  name: 'calls.transfer',
  description:
    "Blind-transfers a live call to an extension or number, or with voicemail into an extension's mailbox; the transferee is routed there as a new call.",
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    await assertOwnLiveCall(ctx, input.id);
    await proxyCallAction(() =>
      getCoreClient().transfer(input.id, {
        target: input.target,
        actorUserId: ctx.actor.id,
        ...(input.voicemail === undefined ? {} : { voicemail: input.voicemail })
      })
    );
    return { id: input.id };
  }
});
