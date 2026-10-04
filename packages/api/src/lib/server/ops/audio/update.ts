import { z } from 'zod';

import { recordFieldChanges } from '../audit.js';
import { propagate } from '../propagate.js';
import { defineOperation } from '../types.js';
import { liveAudioAsset, toAudioAssetOut } from './_shared.js';

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
    const before = await liveAudioAsset(ctx.db, input.id);
    recordFieldChanges(ctx, before, { label: input.label });
    await ctx.db
      .updateTable('audioAssets')
      .set({ label: input.label })
      .where('id', '=', input.id)
      .execute();
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
