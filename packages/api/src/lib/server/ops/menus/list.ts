import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { menuOut, toMenuOut } from './_shared.js';

/** `GET /menus` (§10.3 "Auto-attendant menus"): live menus, alphabetical, paginated. */
export const listMenus = defineOperation({
  name: 'menus.list',
  description: "Lists the tenant's live menus.",
  input: pageInput.strict(),
  output: pageOutput(menuOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db.selectFrom('menus').selectAll().where('deletedAt', 'is', null),
      [
        ['name', 'asc'],
        ['id', 'asc']
      ]
    );
    const items = await Promise.all(page.map(row => toMenuOut(ctx.db, row)));
    return { items, nextPageToken, totalSize };
  }
});
