import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { ringGroupOut, toRingGroupOut } from './_shared.js';

/** `GET /ringGroups` (§10.3 "Ring groups"): live ring groups, alphabetical, paginated. */
export const listRingGroups = defineOperation({
  name: 'ringGroups.list',
  description: "Lists the tenant's live ring groups.",
  input: pageInput.strict(),
  output: pageOutput(ringGroupOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db
        .selectFrom('ringGroups')
        .selectAll()
        .where('deletedAt', 'is', null),
      [
        ['name', 'asc'],
        ['id', 'asc']
      ]
    );
    const items = await Promise.all(
      page.map(row => toRingGroupOut(ctx.db, row))
    );
    return { items, nextPageToken, totalSize };
  }
});
