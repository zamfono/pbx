import { z } from 'zod';

import { pageInput, pageOutput, sqlPage } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import {
  personalAccessTokenWire,
  toPersonalAccessTokenWire
} from './_shared.js';

/** `GET /personalAccessTokens` (§5.2, §10.3): every user's tokens, never their values; an admin's
 *  list leaves out owners' tokens, which are owner-only. */
export const listAll = defineOperation({
  name: 'personalAccessTokens.listAll',
  description:
    "Lists every user's personal access tokens, each with its user, revoked and expired ones until the daily purge, paginated; an admin's list leaves out owners' tokens.",
  input: pageInput.strict(),
  output: pageOutput(
    personalAccessTokenWire.extend({
      user: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().nullable()
      })
    })
  ),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    let query = ctx.db
      .selectFrom('personalAccessTokens')
      .innerJoin('users', 'users.id', 'personalAccessTokens.userId')
      .selectAll('personalAccessTokens')
      .select(['users.name as userName', 'users.email as userEmail']);
    if (ctx.actor.role !== 'owner') {
      query = query.where('users.role', '!=', 'owner');
    }
    const { page, nextPageToken, totalSize } = await sqlPage(
      ctx.operation,
      input,
      query,
      [['personalAccessTokens.id', 'asc']]
    );
    return {
      items: page.map(row => ({
        ...toPersonalAccessTokenWire(row),
        user: { id: row.userId, name: row.userName, email: row.userEmail }
      })),
      nextPageToken,
      totalSize
    };
  }
});
