import { redirect, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';

import { HTTP_SEE_OTHER, mfaMethods } from '@zamfono/shared';

import { loadBranding } from '#lib/server/auth/branding.js';
import type { SecondFactorStep } from '#lib/server/auth/mfa/secondFactorSteps.js';
import { beginSecondFactor } from '#lib/server/auth/mfa/secondFactorSubmit.js';
import { startSecuritySession } from '#lib/server/auth/mfa/securitySession.js';
import { hasMfa } from '#lib/server/auth/mfa/status.js';
import { checkPassword } from '#lib/server/auth/passwordCheck.js';
import { ssoSubmit } from '#lib/server/auth/ssoSubmit.js';
import { getDb } from '#lib/server/db.js';
import { limiter } from '#lib/server/limiter.js';

/** The security page's sign-in: e-mail and password, or the SSO button. The leading underscore
 *  keeps the password out of a re-rendered page, as on the login page. */
export const SecuritySignInSchema = z.object({
  email: z.string(),
  _password: z.string(),
  action: z.enum(['password', 'sso'])
});

/** A refused sign-in, carrying the address back, or the second step of one that passed. */
export type SecuritySignInResult =
  { message: string; email: string } | SecondFactorStep;

/**
 * The fresh sign-in that opens the security page (§5.2 "Authentication pages"): the password
 * step of the login page, refusing alike what it refuses, then the second step where the user
 * has a second factor; an SSO user signs in through their provider instead. Passing opens the
 * page's own session, never an OAuth token.
 */
export async function securitySignIn(
  event: RequestEvent,
  payload: z.infer<typeof SecuritySignInSchema>
): Promise<SecuritySignInResult> {
  if (payload.action === 'sso') {
    return ssoSubmit(event, {}, 'security');
  }
  const db = getDb();
  const checked = await checkPassword(db, payload);
  if (checked === null) {
    const { dictionary } = await loadBranding(db);
    return { message: dictionary.login.invalid, email: payload.email };
  }
  const { user, account, email } = checked;
  const status = await mfaMethods(db, user.id);
  if (hasMfa(status)) {
    return beginSecondFactor(
      event,
      { purpose: 'security', userId: user.id, account, email, client: null },
      status
    );
  }
  limiter.loginSucceeded(account);
  startSecuritySession(event.cookies, user.id);
  return redirect(HTTP_SEE_OTHER, '/auth/security');
}
