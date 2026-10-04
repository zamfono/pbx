import {
  decodeOffsetCursor,
  offsetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toUserGroupOut, userGroupOut } from './_shared.js';

/** `GET /userGroups` (§10.3 "User groups"): live user groups, alphabetical, offset-cursor paginated. */
export const listUserGroups = defineOperation({
  name: 'userGroups.list',
  description: "Lists the tenant's live user groups.",
  input: pageInput.strict(),
  output: pageOutput(userGroupOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { limit } = input;
    const rows = await ctx.db
      .selectFrom('userGroups')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('name')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = offsetPage(ctx.operation, rows, offset, limit);
    const items = await Promise.all(
      page.map(row => toUserGroupOut(ctx.db, row))
    );
    return { items, nextCursor };
  }
});
