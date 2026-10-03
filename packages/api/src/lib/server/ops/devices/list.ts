import { z } from 'zod';

import { HTTP_FORBIDDEN } from '@zamfono/shared';

import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation, OpError } from '../types.js';
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
  readOnly: true,
  run: async (ctx, input) => {
    if (ctx.actor.role === 'user' && ctx.actor.id !== input.userId) {
      throw new OpError(
        HTTP_FORBIDDEN,
        'devices: may list only your own devices'
      );
    }
    const offset = decodeOffsetCursor(input.cursor);
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
    const { page, nextCursor } = offsetPage(rows, offset, limit);
    return { items: page.map(toDeviceOut), nextCursor };
  }
});
