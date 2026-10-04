import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toRingGroupOut } from './_shared.js';

/** `GET /ringGroups` (§10.3 "Ring groups"): live ring groups, alphabetical, offset-cursor paginated. */
export const listRingGroups = defineOperation({
  name: 'ringGroups.list',
  description: "Lists the tenant's live ring groups.",
  input: pageInput.strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { limit } = input;
    const rows = await ctx.db
      .selectFrom('ringGroups')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('name')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = offsetPage(ctx.operation, rows, offset, limit);
    const items = await Promise.all(
      page.map(row => toRingGroupOut(ctx.db, row))
    );
    return { items, nextCursor };
  }
});
