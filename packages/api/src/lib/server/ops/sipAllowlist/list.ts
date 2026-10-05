import {
  decodeIdCursor,
  keysetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { sipAllowlistEntryWire } from './_shared.js';

const inputSchema = pageInput.strict();

/** `GET /sipAllowlist` (§5.6, §10.3 "SIP bans"): the addresses never banned, keyset-paginated. */
export const list = defineOperation({
  name: 'sipAllowlist.list',
  description:
    'Lists the source addresses and ranges never banned for failed SIP attempts',
  input: inputSchema,
  output: pageOutput(sipAllowlistEntryWire),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { limit } = input;
    let query = ctx.db
      .selectFrom('sipAllowlist')
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
        address: row.address,
        label: row.label,
        createdAt: row.createdAt
      })),
      nextCursor
    };
  }
});
