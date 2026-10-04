import { defineOperation } from '#lib/server/ops/types.js';
import {
  decodeIdCursor,
  keysetPage,
  pageInput
} from '#lib/server/pagination.js';

import { targetToWire } from '../_shared.js';

const inputSchema = pageInput.strict();

/** `GET /backups/targets` (§6.5 "Backups"): the tenant's restic destinations, keyset-paginated. */
export const targetsList = defineOperation({
  name: 'backups.targets.list',
  description: "Lists the tenant's backup targets",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { limit } = input;
    let query = ctx.db
      .selectFrom('backupTargets')
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
    return {
      items: page.map(targetToWire),
      nextCursor
    };
  }
});
