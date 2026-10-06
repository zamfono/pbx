/**
 * What a `users.update` changes about how the user logs in (§5.2): promoting a user without a
 * password to owner, and removing a user's e-mail.
 */
import { revokeUserPersonalAccessTokens } from '#lib/server/auth/personalAccessTokens.js';
import {
  revokeResetTokens,
  revokeUserTokens
} from '#lib/server/auth/tokens.js';

import { recordChange } from '../audit.js';
import type { Context } from '../types.js';
import { issueSetPasswordLink } from './_setupMail.js';
import type { UserRow } from './_shared.js';

/** Ends every session and personal access token of `userId`, recorded as the delete cascade
 *  records it, so an undo leaves them revoked (§5.8). */
async function revokeLogins(ctx: Context, userId: string): Promise<void> {
  await revokeUserTokens(ctx.db, userId, ctx.now);
  await revokeUserPersonalAccessTokens(ctx.db, userId, ctx.now);
  recordChange(ctx, { field: 'tokensRevoked', from: false, to: true });
}

/**
 * Promoting a user without a password, an SSO-only one, to owner: an owner logs in only once
 * they have one, so their sessions and personal access tokens end with the promotion, and the
 * set-password link they set it through is issued and mailed. `undefined` for any other change.
 */
export async function promoteWithoutPassword(
  ctx: Context,
  before: UserRow,
  role: UserRow['role'] | undefined
): Promise<string | undefined> {
  if (
    role !== 'owner' ||
    before.role === 'owner' ||
    before.passwordHash !== null
  ) {
    return undefined;
  }
  await revokeLogins(ctx, before.id);
  return issueSetPasswordLink(ctx, before.id, 'reset');
}

/**
 * Removing `before`'s e-mail removes every way they log in (§11.2: a user without one cannot):
 * their sessions, personal access tokens and set-password links are revoked, and their password
 * and SSO binding go in the row's own UPDATE, as the fields returned here; `{}` for any other
 * change.
 */
export async function dropLoginWithEmail(
  ctx: Context,
  before: UserRow,
  email: string | null
): Promise<Partial<Pick<UserRow, 'passwordHash' | 'ssoSubject'>>> {
  if (before.email === null || email !== null) {
    return {};
  }
  await revokeLogins(ctx, before.id);
  await revokeResetTokens(ctx.db, before.id, ctx.now);
  return { passwordHash: null, ssoSubject: null };
}
