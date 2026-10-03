import { z } from 'zod';

import { propagate } from '../propagate.js';
import { softDelete } from '../rows.js';
import { Conflict, defineOperation } from '../types.js';
import { findAudioAssetReferences, liveAudioAsset } from './_shared.js';

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
    const before = await liveAudioAsset(ctx.db, input.id);
    const references = await findAudioAssetReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('audio asset is still in use', references);
    }
    await softDelete(ctx, 'audioAssets', input.id);
    if (before.kind === 'moh') {
      propagate(ctx, ['moh']);
    }
    return { id: input.id };
  }
});
