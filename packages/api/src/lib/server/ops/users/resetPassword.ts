import * as env from '$app/env/private';
import pino from 'pino';
import { z } from 'zod';

import { HTTP_FORBIDDEN, HTTP_NOT_FOUND } from '@zamfono/shared';

import { issueResetToken } from '#lib/server/auth/tokens.js';
import { sendMail } from '#lib/server/mail/index.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { afterCommit } from '../afterCommit.js';
import { setUndoable } from '../audit.js';
import { defineOperation, OpError } from '../types.js';
import { setupLinkFor } from './_setupMail.js';
import { liveUser } from './_shared.js';

const logger = pino({ name: 'users.resetPassword' });

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
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  // A sent e-mail changes nothing of the user an undo would build on (§5.8 "pure actions").
  pureAction: true,
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    const user = await liveUser(ctx.db, input.id);
    if (user.role === 'owner' && ctx.actor.role !== 'owner') {
      throw new OpError(
        HTTP_FORBIDDEN,
        "users: only owners reset an owner's password"
      );
    }
    const { raw, expiresAt } = await issueResetToken(
      ctx.db,
      input.id,
      'setup',
      ctx.now
    );
    const link = setupLinkFor(raw);
    // Sent once the write has committed, never after a rollback; not awaited, as in `users.create`.
    afterCommit(ctx, db => {
      sendMail(db, keyringFromEnv(env), {
        kind: 'reset',
        to: { userId: input.id },
        values: { link, linkExpiresAt: expiresAt }
      }).catch((error: unknown) => {
        logger.warn({ err: error }, 'users.resetPassword: reset mail failed');
      });
      return Promise.resolve(null);
    });
    // Issuing a link is nothing to revert: there is no prior state for undo to restore.
    setUndoable(ctx, false);
    return { link };
  }
});
