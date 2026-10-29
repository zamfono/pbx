import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toUserGroupOut, userGroupOut } from './_shared.js';

/** `GET /userGroups` (§10.3 "User groups"): live user groups, alphabetical, paginated. */
export const listUserGroups = defineOperation({
  name: 'userGroups.list',
  description: "Lists the tenant's live user groups.",
  input: pageInput.strict(),
  output: pageOutput(userGroupOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db
        .selectFrom('userGroups')
        .selectAll()
        .where('deletedAt', 'is', null),
      [
        ['name', 'asc'],
        ['id', 'asc']
      ]
    );
    const items = await Promise.all(
      page.map(row => toUserGroupOut(ctx.db, row))
    );
    return { items, nextPageToken, totalSize };
  }
});
