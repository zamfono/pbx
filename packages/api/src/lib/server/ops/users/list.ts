import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

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
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db.selectFrom('users').selectAll().where('deletedAt', 'is', null),
      [
        ['name', 'asc'],
        ['id', 'asc']
      ]
    );
    const items = await Promise.all(page.map(row => toUserOut(ctx.db, row)));
    return { items, nextPageToken, totalSize };
  }
});
