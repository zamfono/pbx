import {
  decodeIdCursor,
  keysetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toWire } from './_shared.js';

const inputSchema = pageInput.strict();

/** `GET /webhooks` (§10.6): the tenant's configured event receivers, keyset-paginated. */
export const list = defineOperation({
  name: 'webhooks.list',
  description:
    "Lists the tenant's webhooks with their delivery status, ok or failing",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { limit } = input;
    let query = ctx.db
      .selectFrom('webhooks')
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
      items: page.map(toWire),
      nextCursor
    };
  }
});
