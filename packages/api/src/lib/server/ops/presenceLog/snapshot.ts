import { z } from 'zod';

import { PRESENCE_STATUSES } from '@zamfono/shared';

import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { instantInput, tenantInstantReader } from '../instantInput.js';
import { defineOperation } from '../types.js';

const inputSchema = z
  .object({
    at: instantInput.describe(
      "The past instant, ISO 8601 with any offset (none: the tenant's time zone), whose presence states are returned."
    ),
    userId: z
      .string()
      .optional()
      .describe('Only this user; left out, every user.'),
    ...pageInput.shape
  })
  .strict();

/**
 * `GET /presence/log?at=&userId=` (§10.3, §11.2 `presence_log`): each user's latest presence
 * state as of a past instant — the `presence_log` row with the greatest `since` that is still
 * `<= at` — ignoring any row recorded later; paged by user.
 */
export const snapshot = defineOperation({
  name: 'presenceLog.snapshot',
  description: "Snapshots each user's presence state as of a past timestamp.",
  input: inputSchema,
  output: pageOutput(
    z.object({
      userId: z.string(),
      status: z.enum(PRESENCE_STATUSES),
      since: z.string(),
      peer: z.string().nullable(),
      ringGroupId: z.string().nullable()
    })
  ),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const instants = await tenantInstantReader(ctx.db);
    let ranked = ctx.db
      .selectFrom('presenceLog')
      .select(eb => [
        'userId',
        'status',
        'since',
        'peer',
        'ringGroupId',
        eb.fn
          .agg<number>('row_number')
          .over(over =>
            over
              .partitionBy('userId')
              .orderBy('since', 'desc')
              .orderBy('id', 'desc')
          )
          .as('rank')
      ])
      .where('since', '<=', instants.start(input.at));
    if (input.userId !== undefined) {
      ranked = ranked.where('userId', '=', input.userId);
    }
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      ctx.db
        .selectFrom(ranked.as('ranked'))
        .select(['userId', 'status', 'since', 'peer', 'ringGroupId'])
        .where('rank', '=', 1),
      [['userId', 'asc']]
    );
    return { items: page, nextPageToken, totalSize };
  }
});
