import { z } from 'zod';

import { setUndoable } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  assertVoicemailScope,
  deleteVoicemailFile,
  loadVoicemail,
  mailboxKey,
  notifyMwi,
  ringGroupIdsForUser
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
  confirm: input =>
    `Delete this voicemail? This cannot be undone. (${input.id})`,
  entity: input => ({ kind: 'voicemail', id: input.id }),
  run: async (ctx, input) => {
    const row = await loadVoicemail(ctx.db, input.id);
    const ringGroupIds =
      ctx.actor.role === 'user'
        ? await ringGroupIdsForUser(ctx.db, ctx.actor.id)
        : [];
    assertVoicemailScope(ctx.actor.role, ctx.actor.id, row, ringGroupIds);
    await deleteVoicemailFile(row.filename);
    await ctx.db.deleteFrom('voicemails').where('id', '=', input.id).execute();
    setUndoable(ctx, false);
    notifyMwi(mailboxKey(row));
    return { id: input.id };
  }
});
