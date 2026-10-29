import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { resolveOptionalTarget } from '../forwardTargetSpec.js';
import { defineOperation } from '../types.js';
import { didBlockOut } from './_shared.js';

const inputSchema = pageInput.strict();

/** `GET /didBlocks` (§10.3 "Extensions & DIDs", §11.3): live number blocks, keyset-paginated. */
export const list = defineOperation({
  name: 'didBlocks.list',
  description:
    "Lists the tenant's number blocks with their digit counts and fallback targets",
  input: inputSchema,
  output: pageOutput(didBlockOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const query = ctx.db
      .selectFrom('didBlocks')
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
        base: row.base,
        label: row.label,
        digits: row.digits,
        fallbackTarget: await resolveOptionalTarget(
          ctx.db,
          row.fallbackTargetId
        ),
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
