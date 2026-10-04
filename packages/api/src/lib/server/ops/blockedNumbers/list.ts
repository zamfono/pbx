import {
  decodeIdCursor,
  keysetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';

const inputSchema = pageInput.strict();

/** `GET /blockedNumbers` (§10.1 "Entry", §10.3 "Blocklist"): the tenant blocklist, keyset-paginated. */
export const list = defineOperation({
  name: 'blockedNumbers.list',
  description: "Lists the tenant's inbound blocklist",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { limit } = input;
    let query = ctx.db
      .selectFrom('blockedNumbers')
      .selectAll()
      .where('deletedAt', 'is', null);
    if (input.cursor !== undefined) {
      query = query.where(
        'id',
        '>',
        decodeIdCursor(ctx.operation, input.cursor)
      );
    }
    const rows = await query
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(ctx.operation, rows, limit);
    return {
      items: page.map(row => ({
        id: row.id,
        number: row.number,
        isPrefix: row.isPrefix === 1,
        label: row.label,
        createdAt: row.createdAt
      })),
      nextCursor
    };
  }
});
