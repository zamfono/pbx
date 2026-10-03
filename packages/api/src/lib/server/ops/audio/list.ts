import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toAudioAssetOut } from './_shared.js';

/** `GET /audio` (§10.3 "Audio"): live audio assets, alphabetical, offset-cursor paginated. */
export const listAudioAssets = defineOperation({
  name: 'audio.list',
  description: "Lists the tenant's live audio assets.",
  input: pageInput.strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(input.cursor);
    const { limit } = input;
    const rows = await ctx.db
      .selectFrom('audioAssets')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('label')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = offsetPage(rows, offset, limit);
    return { items: page.map(toAudioAssetOut), nextCursor };
  }
});
