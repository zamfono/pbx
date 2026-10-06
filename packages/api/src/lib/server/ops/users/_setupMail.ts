import * as env from '$app/env/private';
import pino from 'pino';

import { issueResetToken } from '#lib/server/auth/tokens.js';
import { sendMail } from '#lib/server/mail/index.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

import { afterCommit } from '../afterCommit.js';
import type { Context } from '../types.js';

const logger = pino({ name: 'users.setPasswordLink' });

const SET_PASSWORD_PATH = '/auth/setPassword';

/**
 * The absolute `https://<FQDN>/auth/setPassword?token=` link a setup or reset mail carries (§5.2,
 * §10.2 "Mail"), the path the page is mounted at.
 */
export function setupLinkFor(token: string): string {
  return `${originFromEnv()}${SET_PASSWORD_PATH}?token=${token}`;
}

/**
 * Issues a user a one-time set-password link, valid 7 days since an admin may hand it over
 * (§5.2), and mails it once the write has committed, never after a rollback; not awaited, as
 * `sendMail`'s retries run over minutes (§10.2 "Failure"). `mail` is the template: `setup`
 * invites a new user, naming who did, `reset` serves an existing one.
 */
export async function issueSetPasswordLink(
  ctx: Context,
  userId: string,
  mail: 'setup' | 'reset'
): Promise<string> {
  const { raw, expiresAt } = await issueResetToken(
    ctx.db,
    userId,
    'setup',
    ctx.now
  );
  const link = setupLinkFor(raw);
  afterCommit(ctx, db => {
    sendMail(db, keyringFromEnv(env), {
      kind: mail,
      to: { userId },
      values: {
        link,
        linkExpiresAt: expiresAt,
        ...(mail === 'setup' ? { invitedBy: ctx.actor.name } : {})
      }
    }).catch((error: unknown) => {
      logger.warn({ err: error }, 'set-password mail failed');
    });
    return Promise.resolve(null);
  });
  return link;
}
