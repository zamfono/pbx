import {
  decodeOffsetCursor,
  offsetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toUserOut, userOut } from './_shared.js';

export const list = defineOperation({
  name: 'users.list',
  description: "Lists the tenant's live users, paginated.",
  input: pageInput.strict(),
  output: pageOutput(userOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { limit } = input;
    const rows = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('name')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = offsetPage(ctx.operation, rows, offset, limit);
    const items = await Promise.all(page.map(row => toUserOut(ctx.db, row)));
    return { items, nextCursor };
  }
});
