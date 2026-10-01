import { z } from 'zod';

import { defineOperation } from '../types.js';
import { targetToWire } from './_shared.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    cursor: z.string().optional()
  })
  .strict();

/** `GET /backups/targets` (§6.5 "Backups"): the tenant's restic destinations, keyset-paginated. */
export const targetsList = defineOperation({
  name: 'backups.targets.list',
  description: "Lists the tenant's backup targets",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('backupTargets')
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
      items: page.map(targetToWire),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null
    };
  }
});
