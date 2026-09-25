import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../pagination.js';
import { defineOperation } from '../types.js';
import { toUserGroupOut } from './_shared.js';

const DEFAULT_LIMIT = 50;

/** `GET /userGroups` (§10.3 "User groups"): live user groups, alphabetical, offset-cursor paginated. */
export const listUserGroups = defineOperation({
  name: 'userGroups.list',
  description: "Lists the tenant's live user groups.",
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
      .selectFrom('userGroups')
      .selectAll()
      .where('deletedAt', 'is', null)
      .orderBy('name')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const items = await Promise.all(
      page.map(row => toUserGroupOut(ctx.db, row))
    );
    const nextCursor =
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null;
    return { items, nextCursor };
  }
});
