import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { resolveTarget } from '../forwardTargetSpec.js';
import { defineOperation } from '../types.js';
import { didOut } from './_shared.js';

const inputSchema = pageInput.strict();

/** `GET /dids` (§10.3 "Extensions & DIDs"): live DIDs, oldest id first, keyset-paginated. */
export const list = defineOperation({
  name: 'dids.list',
  description: "Lists the tenant's DIDs",
  input: inputSchema,
  output: pageOutput(didOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const query = ctx.db
      .selectFrom('dids')
      .selectAll()
      .where('deletedAt', 'is', null);
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      query,
      [['id', 'asc']]
    );
    const items = await Promise.all(
      page.map(async row => ({
        id: row.id,
        number: row.number,
        label: row.label,
        target: await resolveTarget(ctx.db, row.targetId),
        createdAt: row.createdAt
      }))
    );
    return {
      items,
      nextPageToken,
      totalSize
    };
  }
});
