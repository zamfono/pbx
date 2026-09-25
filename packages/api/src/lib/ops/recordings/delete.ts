import { z } from 'zod';

import { setUndoable } from '../runner.js';
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
  confirm: input =>
    `Delete this recording? This cannot be undone. (${input.id})`,
  entity: input => ({ kind: 'recording', id: input.id }),
  run: async (ctx, input) => {
    const row = await loadRecording(ctx.db, input.id);
    await deleteRecordingFile(row.filename);
    await ctx.db.deleteFrom('recordings').where('id', '=', input.id).execute();
    setUndoable(ctx, false);
    return { id: input.id };
  }
});
