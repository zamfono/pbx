import { z } from 'zod';

import { decodeIdCursor, encodeCursor } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    cursor: z.string().optional()
  })
  .strict();

/** `GET /blockedNumbers` (§10.1 "Entry", §10.3 "Blocklist"): the tenant blocklist, keyset-paginated. */
export const list = defineOperation({
  name: 'blockedNumbers.list',
  description: "Lists the tenant's inbound blocklist",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    let query = ctx.db
      .selectFrom('blockedNumbers')
      .selectAll()
      .where('deletedAt', 'is', null);
    if (input.cursor !== undefined) {
      query = query.where('id', '>', decodeIdCursor(input.cursor));
    }
    const rows = await query
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(row => ({
        id: row.id,
        number: row.number,
        isPrefix: row.isPrefix === 1,
        label: row.label,
        createdAt: row.createdAt
      })),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id }) : null
    };
  }
});
