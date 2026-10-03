import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toMenuOut } from './_shared.js';

/** `GET /menus` (§10.3 "Auto-attendant menus"): live menus, alphabetical, offset-cursor paginated. */
export const listMenus = defineOperation({
  name: 'menus.list',
  description: "Lists the tenant's live menus.",
  input: pageInput.strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(input.cursor);
    const { limit } = input;
    const rows = await ctx.db
      .selectFrom('menus')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('name')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = offsetPage(rows, offset, limit);
    const items = await Promise.all(page.map(row => toMenuOut(ctx.db, row)));
    return { items, nextCursor };
  }
});
