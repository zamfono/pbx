import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toWire, webhookWire } from './_shared.js';

const inputSchema = pageInput.strict();

/** `GET /webhooks` (§10.6): the tenant's configured event receivers, keyset-paginated. */
export const list = defineOperation({
  name: 'webhooks.list',
  description:
    "Lists the tenant's webhooks with their delivery status, ok or failing",
  input: inputSchema,
  output: pageOutput(webhookWire),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const query = ctx.db
      .selectFrom('webhooks')
      .selectAll()
      .where('deletedAt', 'is', null);
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      query,
      [['id', 'asc']]
    );
    return {
      items: page.map(toWire),
      nextPageToken,
      totalSize
    };
  }
});
