import { z } from 'zod';

import { decodeCursor, encodeCursor } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toUserOut } from './_shared.js';

const DEFAULT_LIMIT = 50;

export const list = defineOperation({
  name: 'users.list',
  description: "Lists the tenant's live users, paginated.",
  input: z
    .object({
      limit: z.number().int().positive().optional(),
      cursor: z.string().optional()
    })
    .strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset =
      input.cursor === undefined
        ? 0
        : (decodeCursor(input.cursor) as { offset: number }).offset;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('name')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map(row => toUserOut(ctx.db, row)));
    const nextCursor =
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null;
    return { items, nextCursor };
  }
});
