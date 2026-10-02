import { z } from 'zod';

import { decodeIdCursor, encodeCursor } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { resolveTarget } from './_shared.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    cursor: z.string().optional()
  })
  .strict();

/** `GET /dids` (§10.3 "Extensions & DIDs"): live DIDs, oldest id first, keyset-paginated. */
export const list = defineOperation({
  name: 'dids.list',
  description: "Lists the tenant's DIDs",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('dids')
      .selectAll()
      .where('deletedAt', 'is', null)
      .$if(input.cursor !== undefined, qb =>
        qb.where('id', '>', decodeIdCursor(input.cursor ?? ''))
      )
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const items = await Promise.all(
      page.map(async row => ({
        id: row.id,
        number: row.number,
        label: row.label,
        target: await resolveTarget(ctx.db, row.targetId),
        createdAt: row.createdAt
      }))
    );
    return {
      items,
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id }) : null
    };
  }
});
