import { z } from 'zod';

import { afterCommit } from '../afterCommit.js';
import { setUndoable } from '../audit.js';
import { defineOperation } from '../types.js';
import {
  deleteVoicemailFile,
  loadVoicemail,
  mailboxKey,
  notifyMwi,
  ownVoicemail
} from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/**
 * `DELETE /voicemails/{id}` (§5.8): permanently removes a voicemail's row and audio file — a
 * hard delete, since the audio is gone with it and there is nothing left to revert — and
 * notifies `core` so the mailbox's MWI count follows (§3.1, §9.3).
 */
export const deleteVoicemail = defineOperation({
  name: 'voicemails.delete',
  description: 'Permanently deletes a voicemail and its audio file.',
  input: inputSchema,
  minRole: 'user',
  scope: ownVoicemail,
  confirm: async (ctx, input) => {
    const row = await loadVoicemail(ctx, input.id);
    return `Delete the voicemail from ${row.caller} of ${row.createdAt}? This cannot be undone.`;
  },
  entity: input => ({ kind: 'voicemail', id: input.id }),
  run: async (ctx, input) => {
    const row = await loadVoicemail(ctx, input.id);
    await ctx.db.deleteFrom('voicemails').where('id', '=', input.id).execute();
    // Only once the row's delete has committed: a rolled-back one keeps its audio.
    afterCommit(ctx, async () => {
      await deleteVoicemailFile(row.filename);
      return null;
    });
    setUndoable(ctx, false);
    notifyMwi(ctx, mailboxKey(row));
    return { id: input.id };
  }
});
