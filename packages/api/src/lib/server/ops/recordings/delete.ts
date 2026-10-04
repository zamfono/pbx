import { z } from 'zod';

import { afterCommit } from '../afterCommit.js';
import { setUndoable } from '../audit.js';
import { defineOperation } from '../types.js';
import { deleteRecordingFile, loadRecording } from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/**
 * `DELETE /recordings/{id}` (§5.8): permanently removes a recording's row and mixed audio file —
 * a hard delete, since the audio is gone with it and there is nothing left to revert.
 */
export const deleteRecording = defineOperation({
  name: 'recordings.delete',
  description: 'Permanently deletes a call recording and its audio file.',
  input: inputSchema,
  minRole: 'admin',
  confirm: async (ctx, input) => {
    const row = await loadRecording(ctx.db, input.id);
    return `Delete the recording of ${row.createdAt}? This cannot be undone.`;
  },
  entity: input => ({ kind: 'recording', id: input.id }),
  run: async (ctx, input) => {
    const row = await loadRecording(ctx.db, input.id);
    await ctx.db.deleteFrom('recordings').where('id', '=', input.id).execute();
    // Only once the row's delete has committed: a rolled-back one keeps its audio.
    afterCommit(ctx, async () => {
      await deleteRecordingFile(row.filename);
      return null;
    });
    setUndoable(ctx, false);
    return { id: input.id };
  }
});
