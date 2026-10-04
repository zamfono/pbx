import {
  decodeIdCursor,
  keysetPage,
  pageInput
} from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import { ringGroupIdsForUser, toVoicemailOut } from './_shared.js';

const inputSchema = pageInput.strict();

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
    const { limit } = input;
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodeIdCursor(ctx.operation, input.cursor);
    const ringGroupIds =
      ctx.actor.role === 'user'
        ? await ringGroupIdsForUser(ctx.db, ctx.actor.id)
        : [];
    let query = ctx.db.selectFrom('voicemails').selectAll();
    if (ctx.actor.role === 'user') {
      query = query.where(eb =>
        eb.or(
          ringGroupIds.length > 0
            ? [
                eb('mailboxUserId', '=', ctx.actor.id),
                eb('mailboxRingGroupId', 'in', ringGroupIds)
              ]
            : [eb('mailboxUserId', '=', ctx.actor.id)]
        )
      );
    }
    if (cursor !== undefined) {
      query = query.where('id', '<', cursor);
    }
    const rows = await query
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(ctx.operation, rows, limit);
    return {
      items: page.map(toVoicemailOut),
      nextCursor
    };
  }
});
