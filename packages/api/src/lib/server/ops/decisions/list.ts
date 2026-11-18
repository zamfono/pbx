import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { decisionOut, toDecisionOut } from './_shared.js';

/** `GET /decisions` (§10.3 "Decisions"): live decisions, alphabetical, paginated. */
export const listDecisions = defineOperation({
  name: 'decisions.list',
  description: "Lists the tenant's live decisions.",
  input: pageInput.strict(),
  output: pageOutput(decisionOut),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db.selectFrom('decisions').selectAll().where('deletedAt', 'is', null),
      [
        ['name', 'asc'],
        ['id', 'asc']
      ]
    );
    const items = await Promise.all(
      page.map(row => toDecisionOut(ctx.db, row))
    );
    return { items, nextPageToken, totalSize };
  }
});
