import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import {
  decodeIdCursor,
  keysetPage,
  pageInput,
  pageOutput
} from '#lib/server/pagination.js';

import { ownActingUser } from '../gates.js';
import { defineOperation } from '../types.js';
import { liveUser } from '../users/_shared.js';
import {
  forAnOwner,
  personalAccessTokenWire,
  toPersonalAccessTokenWire
} from './_shared.js';

/** `GET /users/{id}/personalAccessTokens` (§5.2, §10.3): a user's tokens, never their values. */
export const list = defineOperation({
  name: 'personalAccessTokens.list',
  description:
    "Lists a user's personal access tokens, revoked and expired ones until the daily purge, paginated.",
  input: z
    .object({
      userId: z.string(),
      ...pageInput.shape
    })
    .strict(),
  output: pageOutput(personalAccessTokenWire),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownActingUser,
  ownerOnly: forAnOwner,
  readOnly: true,
  run: async (ctx, input) => {
    await liveUser(ctx.db, input.userId);
    const { limit } = input;
    let query = ctx.db
      .selectFrom('personalAccessTokens')
      .selectAll()
      .where('userId', '=', input.userId);
    if (input.cursor !== undefined) {
      query = query.where(
        'id',
        '>',
        decodeIdCursor(ctx.operation, input.cursor)
      );
    }
    const rows = await query
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const { page, nextCursor } = keysetPage(ctx.operation, rows, limit);
    return { items: page.map(toPersonalAccessTokenWire), nextCursor };
  }
});
