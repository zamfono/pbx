import { defineOperation } from '#lib/server/ops/types.js';
import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { backupTargetWire, targetToWire } from '../_shared.js';

const inputSchema = pageInput.strict();

/** `GET /backups/targets` (§6.5 "Backups"): the tenant's restic destinations, keyset-paginated. */
export const targetsList = defineOperation({
  name: 'backups.targets.list',
  description: "Lists the tenant's backup targets",
  input: inputSchema,
  output: pageOutput(backupTargetWire),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const query = ctx.db
      .selectFrom('backupTargets')
      .selectAll()
      .where('deletedAt', 'is', null);
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      query,
      [['id', 'asc']]
    );
    return {
      items: page.map(targetToWire),
      nextPageToken,
      totalSize
    };
  }
});
