import pino from 'pino';
import { z } from 'zod';

import { issueResetToken } from '$lib/server/auth/tokens.js';
import { sendMail } from '$lib/server/mail/index.js';
import { keyringFromEnv } from '$lib/server/secretbox.js';

import { setUndoable } from '../runner.js';
import { defineOperation } from '../types.js';
import { mailDb, setupLinkFor } from './_setupMail.js';
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
    // Not awaited: see `users.create` — a held write transaction must not wait on the relay.
    sendMail(mailDb(ctx), keyringFromEnv(process.env), {
      kind: 'reset',
      to: { userId: input.id },
      values: { link, linkExpiresAt: expiresAt }
    }).catch((error: unknown) => {
      logger.warn({ err: error }, 'users.resetPassword: reset mail failed');
    });
    // Issuing a link is nothing to revert: there is no prior state for undo to restore.
    setUndoable(ctx, false);
    return { link };
  }
});
