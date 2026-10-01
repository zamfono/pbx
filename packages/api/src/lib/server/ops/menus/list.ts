import { z } from 'zod';

import { decodeCursor, encodeCursor } from '$lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { toMenuOut } from './_shared.js';

const DEFAULT_LIMIT = 50;

/** `GET /menus` (§10.3 "Auto-attendant menus"): live menus, alphabetical, offset-cursor paginated. */
export const listMenus = defineOperation({
  name: 'menus.list',
  description: "Lists the tenant's live menus.",
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
      .selectFrom('menus')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('name')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map(row => toMenuOut(ctx.db, row)));
    const nextCursor =
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null;
    return { items, nextCursor };
  }
});
