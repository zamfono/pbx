import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toContactOut } from './_shared.js';

/** `GET /contacts` (§10.3 "Phone book"): live contacts, alphabetical, offset-cursor paginated. */
export const listContacts = defineOperation({
  name: 'contacts.list',
  description: "Lists the tenant's live phone-book contacts.",
  input: pageInput.strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { limit } = input;
    const rows = await ctx.db
      .selectFrom('contacts')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('displayName')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = offsetPage(ctx.operation, rows, offset, limit);
    const items = await Promise.all(page.map(row => toContactOut(ctx.db, row)));
    return { items, nextCursor };
  }
});
