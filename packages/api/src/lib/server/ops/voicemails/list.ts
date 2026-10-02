import { z } from 'zod';

import { decodeCursor, encodeCursor } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { ringGroupIdsForUser, toVoicemailOut } from './_shared.js';

const DEFAULT_LIMIT = 50;

const inputSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional()
  })
  .strict();

/**
 * `GET /voicemails` (§5.3, §10.3): a `user` sees their own mailbox plus the mailboxes of the
 * ring groups they belong to, newest first; an admin or owner sees every voicemail.
 */
export const list = defineOperation({
  name: 'voicemails.list',
  description:
    "Lists voicemails newest first: a user's own mailbox and their ring groups', every mailbox for an admin.",
  input: inputSchema,
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const cursor =
      input.cursor === undefined
        ? undefined
        : (decodeCursor(input.cursor) as { id: string }).id;
    const ringGroupIds =
      ctx.actor.role === 'user'
        ? await ringGroupIdsForUser(ctx.db, ctx.actor.id)
        : [];
    const rows = await ctx.db
      .selectFrom('voicemails')
      .selectAll()
      .$if(ctx.actor.role === 'user', qb =>
        qb.where(eb =>
          eb.or(
            ringGroupIds.length > 0
              ? [
                  eb('mailboxUserId', '=', ctx.actor.id),
                  eb('mailboxRingGroupId', 'in', ringGroupIds)
                ]
              : [eb('mailboxUserId', '=', ctx.actor.id)]
          )
        )
      )
      .$if(cursor !== undefined, qb => qb.where('id', '<', cursor ?? ''))
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toVoicemailOut),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id }) : null
    };
  }
});
