import {
  decodeIdCursor,
  keysetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';

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
    const { limit } = input;
    let query = ctx.db
      .selectFrom('didBlocks')
      .selectAll()
      .where('deletedAt', 'is', null);
    if (input.cursor !== undefined) {
      query = query.where(
        'id',
        '>',
        decodeIdCursor(ctx.operation, input.cursor)
      );
    }
    const rows = await query
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(ctx.operation, rows, limit);
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
      nextCursor
    };
  }
});
