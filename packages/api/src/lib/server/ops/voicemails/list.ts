import { z } from 'zod';

import {
  orderByInput,
  orderOf,
  pageInput,
  pageOutput,
  sqlPage
} from '#lib/server/pagination.js';

import { instantInput, tenantInstantReader } from '../instantInput.js';
import { defineOperation } from '../types.js';
import {
  ringGroupIdsForUser,
  toVoicemailOut,
  voicemailOut
} from './_shared.js';

const inputSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe("Only the voicemails in this user's own mailbox."),
    ringGroupId: z
      .string()
      .optional()
      .describe("Only the voicemails in this ring group's mailbox."),
    read: z
      .boolean()
      .optional()
      .describe(
        'true only the voicemails listened to, false only the new ones.'
      ),
    from: instantInput
      .optional()
      .describe(
        "Only voicemails left at or after this ISO 8601 time, any offset (none: the tenant's time zone)."
      ),
    to: instantInput
      .optional()
      .describe(
        "Only voicemails left before this ISO 8601 time, any offset (none: the tenant's time zone), or before the end of this date."
      ),
    orderBy: orderByInput(['createdAt', 'durationS', 'caller'], 'newest first'),
    ...pageInput.shape
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
  output: pageOutput(voicemailOut),
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: async (ctx, input) => {
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
    if (input.userId !== undefined) {
      query = query.where('mailboxUserId', '=', input.userId);
    }
    if (input.ringGroupId !== undefined) {
      query = query.where('mailboxRingGroupId', '=', input.ringGroupId);
    }
    if (input.read !== undefined) {
      query = query.where('read', '=', input.read ? 1 : 0);
    }
    if (input.from !== undefined || input.to !== undefined) {
      const instants = await tenantInstantReader(ctx.db);
      if (input.from !== undefined) {
        query = query.where('createdAt', '>=', instants.start(input.from));
      }
      if (input.to !== undefined) {
        query = query.where('createdAt', '<', instants.end(input.to));
      }
    }
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      query,
      orderOf(input.orderBy, [['id', 'desc']])
    );
    return {
      items: page.map(toVoicemailOut),
      nextPageToken,
      totalSize
    };
  }
});
