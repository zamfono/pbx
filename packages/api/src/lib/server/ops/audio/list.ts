import { z } from 'zod';

import { decodeCursor, encodeCursor } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toAudioAssetOut } from './_shared.js';

const DEFAULT_LIMIT = 50;

/** `GET /audio` (§10.3 "Audio"): live audio assets, alphabetical, offset-cursor paginated. */
export const listAudioAssets = defineOperation({
  name: 'audio.list',
  description: "Lists the tenant's live audio assets.",
  input: z
    .object({
      limit: z.number().int().positive().optional(),
      cursor: z.string().optional()
    })
    .strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset =
      input.cursor === undefined
        ? 0
        : (decodeCursor(input.cursor) as { offset: number }).offset;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('audioAssets')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('label')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null;
    return { items: page.map(toAudioAssetOut), nextCursor };
  }
});
