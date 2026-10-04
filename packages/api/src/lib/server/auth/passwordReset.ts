/**
 * The two password-reset steps (§5.2 "Authentication pages", §5.5 "Forgot password", §10.3
 * `POST /auth/resetRequest` and `POST /auth/reset`), shared by the REST endpoints API clients
 * call and the remote forms the forgot-password and set-password pages submit. Both callers go
 * through these functions and the one limiter, so validation, rate limits, token checks
 * and outcomes are the same whichever path a request takes; each caller only maps the outcome
 * onto its own response (problem+json, or a re-rendered page).
 */
import * as env from '$app/env/private';
import pino from 'pino';
import { z } from 'zod';

import { nowIso, type Db } from '@zamfono/shared';

import { MIN_PASSWORD_LENGTH } from '#lib/auth/passwordPolicy.js';

import { addressKey } from '../addressKey.js';
import { notifyUsersChanged } from '../eventSink.js';
import { limiter } from '../limiter.js';
import { sendMail } from '../mail/index.js';
import { setupLinkFor } from '../ops/users/_setupMail.js';
import { keyringFromEnv } from '../secretbox.js';
import { hashPassword } from './password.js';
import {
  issueResetToken,
  redeemResetToken,
  revokeUserTokens
} from './tokens.js';

const logger = pino({ name: 'auth-reset-request' });

/** `true` while `settings.smtp_host` is set (§10.2 "Without a relay"). */
export async function relayConfigured(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('settings')
    .select('smtpHost')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return row.smtpHost !== null;
}

/** Issues a reset token for `userId` and sends the mail, not awaited (§10.2 "Mail" retries run in
 *  process, up to a few minutes; the caller must not wait on the relay). */
function sendResetMail(db: Db, userId: string): void {
  issueResetToken(db, userId, 'reset', nowIso())
    .then(({ raw, expiresAt }) =>
      sendMail(db, keyringFromEnv(env), {
        kind: 'reset',
        to: { userId },
        values: {
          link: setupLinkFor(raw),
          linkExpiresAt: expiresAt
        }
      })
    )
    .catch((err: unknown) => {
      logger.warn({ err }, 'auth/resetRequest: reset mail failed');
    });
}

const ResetRequestSchema = z.object({ email: z.email() });

/** What a reset request came to: no relay (404), the address limit (429), or accepted. */
export type ResetRequestOutcome =
  | { kind: 'noRelay' }
  | { kind: 'limited'; retryAfterS: number }
  | { kind: 'accepted' };

/** Where a reset request comes from: the client address and its body, read only once the
 *  relay and address checks have let it through. */
export type ResetRequestInput = {
  clientAddress: () => string;
  body: () => Promise<unknown>;
};

/**
 * The forgot-password request (§5.2, §5.5): accepted identically whether the address exists or
 * not, malformed or not; past the per-account limit the mail is dropped silently.
 */
export async function requestPasswordReset(
  db: Db,
  input: ResetRequestInput
): Promise<ResetRequestOutcome> {
  if (!(await relayConfigured(db))) {
    return { kind: 'noRelay' };
  }
  const addressLimit = limiter.check(
    'resetAddress',
    addressKey(input.clientAddress())
  );
  if (!addressLimit.ok) {
    return { kind: 'limited', retryAfterS: addressLimit.retryAfterS };
  }
  const parsed = ResetRequestSchema.safeParse(await input.body());
  // `users.email` is `COLLATE NOCASE` (§11.2): the per-account limit must key on the same
  // normalized form, or varying the address's case gives a fresh 3-per-hour budget per variant.
  if (
    parsed.success &&
    limiter.check('resetAccount', parsed.data.email.toLowerCase()).ok
  ) {
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', parsed.data.email)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (user) {
      sendResetMail(db, user.id);
    }
  }
  return { kind: 'accepted' };
}

const RedeemSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(MIN_PASSWORD_LENGTH)
});

/** What a redemption came to: a malformed body (a missing token or a too-short password), a
 *  token that no longer redeems, or the password set. */
export type RedeemOutcome =
  | { kind: 'invalidRequest' }
  | { kind: 'invalidLink' }
  | { kind: 'passwordSet' };

/**
 * Redeems a single-use set-password token (§5.2 "Tokens"), sets the new Argon2id hash and revokes
 * every refresh token the user held, so no earlier session survives a password reset. Outside the
 * §5.5 rate limits: the token itself is the guard.
 */
export async function redeemPasswordReset(
  db: Db,
  body: unknown
): Promise<RedeemOutcome> {
  const parsed = RedeemSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: 'invalidRequest' };
  }
  const now = nowIso();
  const redeemed = await redeemResetToken(db, parsed.data.token, now);
  if (!redeemed.ok) {
    return { kind: 'invalidLink' };
  }
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', redeemed.userId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!user) {
    return { kind: 'invalidLink' };
  }
  const passwordHash = await hashPassword(parsed.data.password);
  await db
    .updateTable('users')
    .set({ passwordHash })
    .where('id', '=', user.id)
    .execute();
  await revokeUserTokens(db, user.id, now);
  // §10.6: the revoked sessions' `/events` sockets close.
  notifyUsersChanged();
  return { kind: 'passwordSet' };
}
