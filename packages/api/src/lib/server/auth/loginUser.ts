import type { Db, UserRole } from '@zamfono/shared';

import { isRole } from './jwt.js';

/** Whom a sign-in proved and their `credential_epoch` read at its password step (or SSO
 *  callback), which everything it issues before its session carries (§5.2). */
export type SignIn = { userId: string; epoch: number };

/**
 * Whether a user may log in and hold tokens of any kind (§5.2): never one without an e-mail, a
 * phone-only user (§11.2), and an owner only once they have a local password, the break-glass
 * every owner who can log in keeps. One an owner created, or an SSO-only user promoted to owner,
 * sets it through their set-password link first. A user it admits has an e-mail, which its type
 * then says.
 */
export function mayLogIn<
  U extends { role: string; email: string | null; passwordHash: string | null }
>(user: U): user is U & { email: string } {
  return (
    user.email !== null && (user.role !== 'owner' || user.passwordHash !== null)
  );
}

/**
 * The live user `id` as a token acts for them, read fresh from `users`, with their
 * `credential_epoch`; `null` for a soft-deleted user, a stored role that is none of the three
 * (§5.3), one `mayLogIn` refuses, or, given the `epoch` a sign-in read at its password step (§5.2),
 * one whose epoch has moved on since: a password reset, an MFA reset or a soft delete came between.
 * Every path that issues or accepts a token asks here.
 */
export async function loginUser(
  db: Db,
  id: string,
  epoch?: number
): Promise<{
  id: string;
  name: string;
  role: UserRole;
  credentialEpoch: number;
} | null> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'name', 'role', 'email', 'passwordHash', 'credentialEpoch'])
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (
    !user ||
    !isRole(user.role) ||
    !mayLogIn(user) ||
    (epoch !== undefined && epoch !== user.credentialEpoch)
  ) {
    return null;
  }
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    credentialEpoch: user.credentialEpoch
  };
}
