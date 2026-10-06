import type { Db, UserRole } from '@zamfono/shared';

import { isRole } from './jwt.js';

/**
 * Whether a user may log in and hold tokens of any kind (§5.2): never one without an e-mail, a
 * phone-only user (§11.2), and an owner only once they have a local password, the break-glass
 * every owner who can log in keeps. One an owner created, or an SSO-only user promoted to owner,
 * sets it through their set-password link first.
 */
export function mayLogIn(user: {
  role: string;
  email: string | null;
  passwordHash: string | null;
}): boolean {
  return (
    user.email !== null && (user.role !== 'owner' || user.passwordHash !== null)
  );
}

/**
 * The live user `id` as a token acts for them, read fresh from `users`; `null` for a soft-deleted
 * user, a stored role that is none of the three (§5.3), or one `mayLogIn` refuses. Every path that
 * issues or accepts a token asks here.
 */
export async function loginUser(
  db: Db,
  id: string
): Promise<{ id: string; name: string; role: UserRole } | null> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'name', 'role', 'email', 'passwordHash'])
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!user || !isRole(user.role) || !mayLogIn(user)) {
    return null;
  }
  return { id: user.id, name: user.name, role: user.role };
}
