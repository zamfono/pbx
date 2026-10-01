import { z } from 'zod';

import { decodeCursor, encodeCursor } from '$lib/server/pagination.js';

import { defineOperation, OpError } from '../types.js';
import { toDeviceOut } from './_shared.js';

const STATUS_FORBIDDEN = 403;
const DEFAULT_LIMIT = 50;

/** `GET /users/{id}/devices` (§10.3): a `user` actor lists only their own devices (§5.3). */
export const list = defineOperation({
  name: 'devices.list',
  description: "Lists a user's live devices, paginated.",
  input: z
    .object({
      userId: z.string(),
      limit: z.number().int().positive().optional(),
      cursor: z.string().optional()
    })
    .strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    if (ctx.actor.role === 'user' && ctx.actor.id !== input.userId) {
      throw new OpError(
        STATUS_FORBIDDEN,
        'devices: may list only your own devices'
      );
    }
    const offset =
      input.cursor === undefined
        ? 0
        : (decodeCursor(input.cursor) as { offset: number }).offset;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .selectFrom('devices')
      .selectAll()
      .where('userId', '=', input.userId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit ? encodeCursor({ offset: offset + limit }) : null;
    return { items: page.map(toDeviceOut), nextCursor };
  }
});
