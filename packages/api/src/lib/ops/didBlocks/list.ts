import { z } from 'zod';

import { resolveOptionalTarget } from '../dids/_shared.js';
import { defineOperation } from '../types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    cursor: z.string().optional()
  })
  .strict();

/** `GET /didBlocks` (§10.3 "Extensions & DIDs", §11.3): live number blocks, keyset-paginated. */
export const list = defineOperation({
  name: 'didBlocks.list',
  description: "Lists the tenant's number blocks",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('didBlocks')
      .selectAll()
      .where('deletedAt', 'is', null)
      .$if(input.cursor !== undefined, qb =>
        qb.where('id', '>', input.cursor ?? '')
      )
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
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
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null
    };
  }
});
