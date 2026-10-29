import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { audioAssetOut, toAudioAssetOut } from './_shared.js';

/** `GET /audio` (§10.3 "Audio"): live audio assets, alphabetical, paginated. */
export const listAudioAssets = defineOperation({
  name: 'audio.list',
  description: "Lists the tenant's live audio assets.",
  input: pageInput.strict(),
  output: pageOutput(audioAssetOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db
        .selectFrom('audioAssets')
        .selectAll()
        .where('deletedAt', 'is', null),
      [
        ['label', 'asc'],
        ['id', 'asc']
      ]
    );
    return { items: page.map(toAudioAssetOut), nextPageToken, totalSize };
  }
});
