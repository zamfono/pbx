import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { toAudioAssetOut } from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const updateAudioAssetInput = z
  .object({ id: z.string(), label: z.string().min(1) })
  .strict();

/** `PATCH /audio/{id}` (§10.3 "Audio"): renames an audio asset; the file itself is immutable. */
export const updateAudioAsset = defineOperation({
  name: 'audio.update',
  description: "Updates an audio asset's label.",
  input: updateAudioAssetInput,
  minRole: 'admin',
  entity: input => ({ kind: 'audio', id: input.id }),
  run: async (ctx, input) => {
    const before = await ctx.db
      .selectFrom('audioAssets')
      .selectAll()
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!before) {
      throw new OpError(
        STATUS_NOT_FOUND,
        `audio asset '${input.id}' not found`
      );
    }
    if (input.label !== before.label) {
      recordChange(ctx, {
        field: 'label',
        from: before.label,
        to: input.label
      });
      await ctx.db
        .updateTable('audioAssets')
        .set({ label: input.label })
        .where('id', '=', input.id)
        .execute();
    }
    const row = await ctx.db
      .selectFrom('audioAssets')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirstOrThrow();
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return toAudioAssetOut(row);
  }
});
