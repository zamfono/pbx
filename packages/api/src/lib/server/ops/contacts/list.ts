import { z } from 'zod';

import { decodeCursor, encodeCursor } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toContactOut } from './_shared.js';

const DEFAULT_LIMIT = 50;

/** `GET /contacts` (§10.3 "Phone book"): live contacts, alphabetical, offset-cursor paginated. */
export const listContacts = defineOperation({
  name: 'contacts.list',
  description: "Lists the tenant's live phone-book contacts.",
  input: z
    .object({
      limit: z.number().int().positive().optional(),
      cursor: z.string().optional()
    })
    .strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    const offset =
      input.cursor === undefined
        ? 0
        : (decodeCursor(input.cursor) as { offset: number }).offset;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('contacts')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('displayName')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map(row => toContactOut(ctx.db, row)));
    const nextCursor =
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null;
    return { items, nextCursor };
  }
});
