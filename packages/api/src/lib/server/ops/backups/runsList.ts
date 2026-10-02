import { z } from 'zod';

import { decodeIdCursor, encodeCursor } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { runToWire } from './_shared.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    targetId: z.string().optional().describe("Only this target's runs."),
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    cursor: z.string().optional()
  })
  .strict();

/**
 * `GET /backups/runs` (§6.5 "Backups"): run history, newest first (ids are UUIDv7 and therefore
 * time-ordered, so a descending id order is a descending start-time order).
 */
export const runsList = defineOperation({
  name: 'backups.runs.list',
  description: 'Lists backup runs, newest first',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('backupRuns')
      .selectAll()
      .$if(input.targetId !== undefined, qb =>
        qb.where('targetId', '=', input.targetId ?? '')
      )
      .$if(input.cursor !== undefined, qb =>
        qb.where('id', '<', decodeIdCursor(input.cursor ?? ''))
      )
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(runToWire),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id }) : null
    };
  }
});
