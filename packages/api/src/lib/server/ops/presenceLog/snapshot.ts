import { z } from 'zod';

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
      .describe('Only this user; left out, every user.')
  })
  .strict();

type PresenceSnapshotItem = {
  userId: string;
  status: string;
  since: string;
  peer: string | null;
  ringGroupId: string | null;
};

/**
 * `GET /presence/log?at=&userId=` (§10.3, §11.2 `presence_log`): each user's latest presence
 * state as of a past instant — the `presence_log` row with the greatest `since` that is still
 * `<= at` — ignoring any row recorded later.
 */
export const snapshot = defineOperation({
  name: 'presenceLog.snapshot',
  description: "Snapshots each user's presence state as of a past timestamp.",
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const toStoredInstant = await tenantInstantReader(ctx.db);
    let query = ctx.db
      .selectFrom('presenceLog')
      .selectAll()
      .where('since', '<=', toStoredInstant(input.at));
    if (input.userId !== undefined) {
      query = query.where('userId', '=', input.userId);
    }
    const rows = await query
      .orderBy('userId')
      .orderBy('since', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const latestByUser = new Map<string, PresenceSnapshotItem>();
    for (const row of rows) {
      if (!latestByUser.has(row.userId)) {
        latestByUser.set(row.userId, {
          userId: row.userId,
          status: row.status,
          since: row.since,
          peer: row.peer,
          ringGroupId: row.ringGroupId
        });
      }
    }
    return { items: [...latestByUser.values()] };
  }
});
