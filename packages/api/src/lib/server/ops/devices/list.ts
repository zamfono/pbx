import { z } from 'zod';

import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { ownActingUser } from '../gates.js';
import { defineOperation } from '../types.js';
import { deviceOut, toDevicesOut } from './_shared.js';

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
  output: pageOutput(deviceOut),
  minRole: 'user',
  scope: ownActingUser,
  readOnly: true,
  run: async (ctx, input) => {
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db
        .selectFrom('devices')
        .selectAll()
        .where('userId', '=', input.userId)
        .where('deletedAt', 'is', null),
      [
        ['createdAt', 'asc'],
        ['id', 'asc']
      ]
    );
    return {
      items: await toDevicesOut(ctx.db, page),
      nextPageToken,
      totalSize
    };
  }
});
