/**
 * How a user's second factors are reported, and whether they must have one (§5.2 "Two-factor
 * authentication"): owners and admins always, every user once `settings.mfa_required_for_all`
 * is set.
 */
import { z } from 'zod';

import type { Db, MfaMethods, UserRole } from '@zamfono/shared';

/** A user's methods as `users.get` and `users.list` report them: counts and flags, never a
 *  secret. */
export const mfaOut = z
  .object({
    totp: z.boolean().describe('An authenticator app is set up.'),
    passkeys: z.number().describe('Passkeys registered.'),
    recoveryCodesLeft: z.number().describe('Unused recovery codes.')
  })
  .describe("The user's two-factor methods (§5.2); never a secret.");

/** Whether `status` holds a method that passes the second step on its own: recovery codes are a
 *  fallback, never the method itself. */
export function hasMfa(status: MfaMethods): boolean {
  return status.totp || status.passkeys > 0;
}

/** Whether a user of `role` must pass a second factor at every password login. */
export async function mfaRequired(db: Db, role: UserRole): Promise<boolean> {
  if (role === 'owner' || role === 'admin') {
    return true;
  }
  const settings = await db
    .selectFrom('settings')
    .select('mfaRequiredForAll')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return settings.mfaRequiredForAll === 1;
}
