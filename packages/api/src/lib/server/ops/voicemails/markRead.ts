import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  loadVoicemail,
  mailboxKey,
  notifyMwi,
  ownVoicemail
} from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    read: z
      .boolean()
      .describe(
        'true marks it read, false unread again; the message-waiting light counts the unread ones.'
      )
  })
  .strict();

/**
 * `PATCH /voicemails/{id}` (§5.7): marks a voicemail read or unread, outside the audit log like
 * every read-flag change, and notifies `core` so the mailbox's MWI count follows (§3.1, §9.3).
 */
export const markRead = defineOperation({
  name: 'voicemails.markRead',
  description: 'Marks a voicemail read or unread.',
  input: inputSchema,
  minRole: 'user',
  scope: ownVoicemail,
  audit: false,
  run: async (ctx, input) => {
    const row = await loadVoicemail(ctx, input.id);
    await ctx.db
      .updateTable('voicemails')
      .set({ read: Number(input.read) })
      .where('id', '=', input.id)
      .execute();
    notifyMwi(ctx, mailboxKey(row));
    return { id: input.id, read: input.read };
  }
});
