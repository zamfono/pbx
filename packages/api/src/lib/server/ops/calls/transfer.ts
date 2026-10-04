import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';

import { defineOperation, OpError } from '../types.js';
import {
  assertOwnLiveCall,
  liveCallIdInput,
  proxyCallAction
} from './_shared.js';

const inputSchema = z
  .object({
    id: liveCallIdInput,
    target: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Blind transfer: what to dial, as a phone would: an extension, or an external number E.164 or national; with voicemail, the extension whose mailbox takes the call. Give this or toCallId.'
      ),
    voicemail: z
      .boolean()
      .optional()
      .describe(
        'Puts the transferee straight through to the mailbox of the user or ring group owning the target extension, without ringing, as *97<ext> does; 422 noMailbox when nobody owns it.'
      ),
    toCallId: liveCallIdInput
      .optional()
      .describe(
        "Attended transfer: the consultation call's id calls.consult returned; the held party joins whoever answered it, and you leave both calls. Give this or target."
      )
  })
  .strict();

/**
 * `POST /calls/{id}/transfer` (§10.1 "Transfers and pickup", §5.7): blind-transfers the live
 * call `id` to `target`, or with `voicemail` to `*97<target>`, its mailbox (§9.3), or, with
 * `toCallId`, joins its held party to the consultation `calls.consult` started as a phone's
 * attended transfer does, the actor controlling both calls; proxied to `core`, and recorded with
 * the acting user in the call's own history entry rather than the audit log.
 */
export const transfer = defineOperation({
  name: 'calls.transfer',
  description:
    "Transfers a live call: blind to an extension or number (target), or with voicemail into an extension's mailbox, where the transferee is routed as a new call; or attended to the consultation calls.consult started (toCallId), where the held party and the consulted party talk on without you.",
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    const { target, toCallId, voicemail } = input;
    const actorUserId = ctx.actor.id;
    if (target !== undefined && toCallId === undefined) {
      await assertOwnLiveCall(ctx, input.id);
      await proxyCallAction(() =>
        getCoreClient().transfer(input.id, {
          target,
          actorUserId,
          ...(voicemail === undefined ? {} : { voicemail })
        })
      );
      return { id: input.id };
    }
    if (
      toCallId !== undefined &&
      target === undefined &&
      voicemail === undefined
    ) {
      await assertOwnLiveCall(ctx, input.id);
      await assertOwnLiveCall(ctx, toCallId);
      await proxyCallAction(() =>
        getCoreClient().attendedTransfer(input.id, {
          toCallId,
          actorUserId
        })
      );
      return { id: input.id };
    }
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'calls: give either target (with voicemail, if wanted) or toCallId'
    );
  }
});
