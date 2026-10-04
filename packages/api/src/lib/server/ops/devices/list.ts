import { z } from 'zod';

import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { ownActingUser } from '../gates.js';
import { defineOperation } from '../types.js';
import { toDeviceOut } from './_shared.js';

/** `GET /users/{id}/devices` (§10.3): a `user` actor lists only their own devices (§5.3). */
export const list = defineOperation({
  name: 'devices.list',
  description: "Lists a user's live devices, paginated.",
  input: z
    .object({
      userId: z.string(),
      ...pageInput.shape
    })
    .strict(),
  minRole: 'user',
  scope: ownActingUser,
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { limit } = input;
    const rows = await ctx.db
      .selectFrom('devices')
      .selectAll()
      .where('userId', '=', input.userId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = offsetPage(ctx.operation, rows, offset, limit);
    return { items: page.map(toDeviceOut), nextCursor };
  }
});
