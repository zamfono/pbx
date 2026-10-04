import { z } from 'zod';

import { defineOperation } from '#lib/server/ops/types.js';
import {
  decodeIdCursor,
  keysetPage,
  pageInput
} from '#lib/server/pagination.js';

import { runToWire } from '../_shared.js';

const inputSchema = z
  .object({
    targetId: z.string().optional().describe("Only this target's runs."),
    ...pageInput.shape
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
    const { limit } = input;
    let query = ctx.db.selectFrom('backupRuns').selectAll();
    if (input.targetId !== undefined) {
      query = query.where('targetId', '=', input.targetId);
    }
    if (input.cursor !== undefined) {
      query = query.where(
        'id',
        '<',
        decodeIdCursor(ctx.operation, input.cursor)
      );
    }
    const rows = await query
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(ctx.operation, rows, limit);
    return {
      items: page.map(runToWire),
      nextCursor
    };
  }
});
