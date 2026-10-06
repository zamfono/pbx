import { z } from 'zod';

import type { Db, UserRole } from '@zamfono/shared';

import { limiter } from '#lib/server/limiter.js';
import { accountLockKey } from '#lib/server/ops/users/_accountLock.js';

import { lookupUser } from './authorizeRequest.js';
import { verifyPassword } from './password.js';

// A well-formed address and a non-empty password, checked here rather than in the form schema:
// every refusal a sign-in form renders carries the same generic message (§5.5), so field-level
// validation issues would distinguish submissions that must stay indistinguishable.
const CredentialsSchema = z.object({
  email: z.email(),
  _password: z.string().min(1)
});

/** The account a password sign-in proved, with its §5.5 lock key and the address typed. */
export type CheckedPassword = {
  user: { id: string; role: UserRole };
  account: string;
  email: string;
};

/**
 * The password step of a sign-in form (§5.2, §5.5), on the login page and the security page:
 * `null` for a malformed submission, a locked account, an unknown address or a wrong password
 * alike. The attempt counts against the account lock before the password is checked and stays
 * counted: the caller settles it (`limiter.loginSucceeded`) once the whole sign-in has passed.
 */
export async function checkPassword(
  db: Db,
  credentials: { email: string; _password: string }
): Promise<CheckedPassword | null> {
  const parsed = CredentialsSchema.safeParse(credentials);
  if (!parsed.success) {
    return null;
  }
  const { email, _password: password } = parsed.data;
  // `users.email` is `COLLATE NOCASE` (§11.2): the account lock must key on the same normalized
  // form, or varying the address's case gives an attacker a fresh 5-attempt budget per variant,
  // and the user record must read it back under that same form (`accountLockKey`).
  const account = accountLockKey(email);
  if (!limiter.countLoginAttempt(account)) {
    // Costs the same Argon2id pass a wrong-password response costs (`verifyPassword`'s own dummy
    // hash), so a locked account's response time matches a wrong password's (§5.5).
    await verifyPassword(null, password);
    return null;
  }
  const user = await lookupUser(db, email);
  const verified = await verifyPassword(user?.passwordHash ?? null, password);
  if (!verified || !user) {
    return null;
  }
  return { user: { id: user.id, role: user.role }, account, email };
}
