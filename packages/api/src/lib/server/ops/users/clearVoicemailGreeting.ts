import { z } from 'zod';

import { propagate } from '../runner.js';
import { defineOperation } from '../types.js';
import { assertOwnGreeting } from './_greeting.js';
import { liveUser } from './_shared.js';

/**
 * `DELETE /users/{id}/voicemailGreeting` (§10.2 "Voicemail", "Mailbox access"): the user's
 * mailbox greets with the language default prompt again. The greeting's own audio asset stays,
 * as one a newer `*96` recording replaced does. Outside the audit log like the greeting itself
 * (§5.7).
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
  audit: false,
  confirm: () =>
    "Remove this user's voicemail greeting? Callers then hear the default prompt.",
  run: async (ctx, input) => {
    assertOwnGreeting(ctx, input.id);
    await liveUser(ctx.db, input.id);
    await ctx.db
      .updateTable('users')
      .set({ mailboxAudioId: null })
      .where('id', '=', input.id)
      .execute();
    propagate(ctx, []);
    return { id: input.id, mailboxAudioId: null };
  }
});
