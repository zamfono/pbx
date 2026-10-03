import {
  decodeIdCursor,
  keysetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { resolveTarget } from './_shared.js';

const inputSchema = pageInput.strict();

/** `GET /dids` (§10.3 "Extensions & DIDs"): live DIDs, oldest id first, keyset-paginated. */
export const list = defineOperation({
  name: 'dids.list',
  description: "Lists the tenant's DIDs",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { limit } = input;
    let query = ctx.db
      .selectFrom('dids')
      .selectAll()
      .where('deletedAt', 'is', null);
    if (input.cursor !== undefined) {
      query = query.where('id', '>', decodeIdCursor(input.cursor));
    }
    const rows = await query
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(rows, limit);
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
      nextCursor
    };
  }
});
