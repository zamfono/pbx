import { z } from 'zod';

import { decodeCursor, encodeCursor } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toRecordingOut } from './_shared.js';

const DEFAULT_LIMIT = 50;

const inputSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional()
  })
  .strict();

/** `GET /recordings` (§5.3): every call recording, newest first; `admin`/`owner` only. */
export const list = defineOperation({
  name: 'recordings.list',
  description:
    'Lists call recordings, newest first: one per recorded user and call (see zamfono.help recording-consent).',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const cursor =
      input.cursor === undefined
        ? undefined
        : (decodeCursor(input.cursor) as { id: string }).id;
    const rows = await ctx.db
      .selectFrom('recordings')
      .selectAll()
      .$if(cursor !== undefined, qb => qb.where('id', '<', cursor ?? ''))
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toRecordingOut),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id }) : null
    };
  }
});
