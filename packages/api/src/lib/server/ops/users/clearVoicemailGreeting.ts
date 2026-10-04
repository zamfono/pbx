import { z } from 'zod';

import { retireGreeting } from '@zamfono/shared';

import { ownUserId } from '../gates.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import { liveUser } from './_shared.js';

/**
 * `DELETE /users/{id}/voicemailGreeting` (§10.2 "Voicemail", "Mailbox access"): the user's
 * mailbox greets with the language default prompt again, and the greeting's own audio asset is
 * soft-deleted, as one a newer greeting replaces is. Outside the audit log like the greeting
 * itself (§5.7).
 */
export const clearVoicemailGreeting = defineOperation({
  name: 'users.clearVoicemailGreeting',
  description:
    "Removes a user's personal voicemail greeting; callers hear the default prompt in the tenant language again.",
  input: z
    .object({
      id: z.string().describe('The user whose mailbox greeting goes.')
    })
    .strict(),
  minRole: 'user',
  scope: ownUserId,
  audit: false,
  confirm: async (ctx, input) =>
    `Remove the voicemail greeting of ${(await liveUser(ctx.db, input.id)).name}? Callers then hear the default prompt.`,
  run: async (ctx, input) => {
    const user = await liveUser(ctx.db, input.id);
    await ctx.db
      .updateTable('users')
      .set({ mailboxAudioId: null })
      .where('id', '=', input.id)
      .execute();
    await retireGreeting(ctx.db, user.mailboxAudioId, ctx.now);
    propagate(ctx, []);
    return { id: input.id, mailboxAudioId: null };
  }
});
