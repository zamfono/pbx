import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  assertVoicemailScope,
  loadVoicemail,
  mailboxKey,
  notifyMwi,
  ringGroupIdsForUser
} from './_shared.js';

const inputSchema = z.object({ id: z.string(), read: z.boolean() }).strict();

/**
 * `PATCH /voicemails/{id}` (§5.7): marks a voicemail read or unread, outside the audit log like
 * every read-flag change, and notifies `core` so the mailbox's MWI count follows (§3.1, §9.3).
 */
export const markRead = defineOperation({
  name: 'voicemails.markRead',
  description: 'Marks a voicemail read or unread.',
  input: inputSchema,
  minRole: 'user',
  audit: false,
  run: async (ctx, input) => {
    const row = await loadVoicemail(ctx.db, input.id);
    const ringGroupIds =
      ctx.actor.role === 'user'
        ? await ringGroupIdsForUser(ctx.db, ctx.actor.id)
        : [];
    assertVoicemailScope(ctx.actor.role, ctx.actor.id, row, ringGroupIds);
    await ctx.db
      .updateTable('voicemails')
      .set({ read: Number(input.read) })
      .where('id', '=', input.id)
      .execute();
    notifyMwi(mailboxKey(row));
    return { id: input.id, read: input.read };
  }
});
