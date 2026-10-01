import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, OpError } from '../types.js';
import { findAudioAssetReferences } from './_shared.js';

const STATUS_NOT_FOUND = 404;

/**
 * `DELETE /audio/{id}` (§5.9): soft-deletes an audio asset; the file stays on the media volume
 * during the undo window and is removed only by the daily purge job.
 */
export const deleteAudioAsset = defineOperation({
  name: 'audio.delete',
  description: 'Soft-deletes an audio asset.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: input =>
    `Delete this audio asset? The deletion can be undone for 30 days. (${input.id})`,
  entity: input => ({ kind: 'audio', id: input.id }),
  run: async (ctx, input) => {
    const before = await ctx.db
      .selectFrom('audioAssets')
      .select(['id', 'kind'])
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!before) {
      throw new OpError(
        STATUS_NOT_FOUND,
        `audio asset '${input.id}' not found`
      );
    }
    const references = await findAudioAssetReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('audio asset is still in use', references);
    }
    await ctx.db
      .updateTable('audioAssets')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    if (before.kind === 'moh') {
      propagate(ctx, ['moh']);
    }
    return { id: input.id };
  }
});
