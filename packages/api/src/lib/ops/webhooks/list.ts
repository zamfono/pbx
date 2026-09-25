import { z } from 'zod';

import { defineOperation } from '../types.js';
import { toWire } from './_shared.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    cursor: z.string().optional()
  })
  .strict();

/** `GET /webhooks` (§10.6): the tenant's configured event receivers, keyset-paginated. */
export const list = defineOperation({
  name: 'webhooks.list',
  description: "Lists the tenant's webhooks",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('webhooks')
      .selectAll()
      .where('deletedAt', 'is', null)
      .$if(input.cursor !== undefined, qb =>
        qb.where('id', '>', input.cursor ?? '')
      )
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    return {
      items: page.map(toWire),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null
    };
  }
});
