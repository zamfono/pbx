import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { blockedNumberWire } from './_shared.js';

const inputSchema = pageInput.strict();

/** `GET /blockedNumbers` (§10.1 "Entry", §10.3 "Blocklist"): the tenant blocklist, keyset-paginated. */
export const list = defineOperation({
  name: 'blockedNumbers.list',
  description: "Lists the tenant's inbound blocklist",
  input: inputSchema,
  output: pageOutput(blockedNumberWire),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const query = ctx.db
      .selectFrom('blockedNumbers')
      .selectAll()
      .where('deletedAt', 'is', null);
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      query,
      [['id', 'asc']]
    );
    return {
      items: page.map(row => ({
        id: row.id,
        number: row.number,
        isPrefix: row.isPrefix === 1,
        label: row.label,
        createdAt: row.createdAt
      })),
      nextPageToken,
      totalSize
    };
  }
});
