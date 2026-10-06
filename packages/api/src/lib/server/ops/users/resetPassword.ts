import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND } from '@zamfono/shared';

import { setUndoable } from '../audit.js';
import { defineOperation, OpError } from '../types.js';
import { issueSetPasswordLink } from './_setupMail.js';
import { liveUser, namesAnOwner } from './_shared.js';

/** `POST /users/{id}/resetPassword` (§10.3, §5.2): issues a fresh one-time set-password link,
 *  valid as long as a setup link, since the admin hands it over. An owner's is owner-only. */
export const resetPassword = defineOperation({
  name: 'users.resetPassword',
  description: "Issues a new one-time link to set a user's password.",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({
    link: z
      .string()
      .describe(
        'The one-time link the user sets a new password with, also mailed to them.'
      )
  }),
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  ownerOnly: namesAnOwner,
  // A sent e-mail changes nothing of the user an undo would build on (§5.8 "pure actions").
  pureAction: true,
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    if ((await liveUser(ctx.db, input.id)).email === null) {
      throw new OpError(
        HTTP_CONFLICT,
        'users: a user without an e-mail cannot log in, so has no password to set'
      );
    }
    const link = await issueSetPasswordLink(ctx, input.id, 'reset');
    // Issuing a link is nothing to revert: there is no prior state for undo to restore.
    setUndoable(ctx, false);
    return { link };
  }
});
