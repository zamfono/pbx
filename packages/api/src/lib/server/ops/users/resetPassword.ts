import * as env from '$app/env/private';
import pino from 'pino';
import { z } from 'zod';

import { issueResetToken } from '#lib/server/auth/tokens.js';
import { sendMail } from '#lib/server/mail/index.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { afterCommit, setUndoable } from '../runner.js';
import { defineOperation } from '../types.js';
import { setupLinkFor } from './_setupMail.js';
import { liveUser } from './_shared.js';

const logger = pino({ name: 'users.resetPassword' });

/** `POST /users/{id}/resetPassword` (§10.3, §5.2): issues a fresh one-time set-password link. */
export const resetPassword = defineOperation({
  name: 'users.resetPassword',
  description: "Issues a new one-time link to set a user's password.",
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  // A sent e-mail changes nothing of the user an undo would build on (§5.8 "pure actions").
  pureAction: true,
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    await liveUser(ctx.db, input.id);
    const { raw, expiresAt } = await issueResetToken(
      ctx.db,
      input.id,
      'reset',
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
