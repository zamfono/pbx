import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import { z } from 'zod';

import { mfaMethods } from '@zamfono/shared';

import {
  AuthorizePayloadSchema,
  paramsFromPayload,
  resolveClient
} from '#lib/server/auth/authorizeRequest.js';
import { loadBranding } from '#lib/server/auth/branding.js';
import {
  completeLogin,
  type ConsentStep
} from '#lib/server/auth/completeLogin.js';
import type { SecondFactorStep } from '#lib/server/auth/mfa/secondFactorSteps.js';
import { beginSecondFactor } from '#lib/server/auth/mfa/secondFactorSubmit.js';
import { hasMfa, mfaRequired } from '#lib/server/auth/mfa/status.js';
import { checkPassword } from '#lib/server/auth/passwordCheck.js';
import { getDb } from '#lib/server/db.js';
import { limiter } from '#lib/server/limiter.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

/** The login form's own fields, on top of the outer request's client parameters (§5.2). The
 *  leading underscore keeps the password out of the re-rendered page: SvelteKit repopulates a
 *  non-enhanced submission's fields from the submitted values, and skips the underscored ones. */
export const LoginPayloadSchema = AuthorizePayloadSchema.extend({
  email: z.string(),
  _password: z.string(),
  action: z.enum(['password', 'sso'])
});

export type LoginPayload = z.infer<typeof LoginPayloadSchema>;

/** The page's rendered outcomes: the generic refusal, the second step, or the consent step
 *  (§5.2). A refusal carries the submitted address back, so only the password has to be typed
 *  again. */
export type LoginResult =
  { message: string; email: string } | SecondFactorStep | ConsentStep;

/**
 * The password form (§5.2 "Authentication pages", §5.5): wrong password or a locked account both
 * answer the same generic message (`checkPassword`), so neither reveals whether the account
 * exists. A user who has
 * a second factor, or must have one, goes on to the second step, and the attempt stays counted
 * against the account lock until that passes too; anyone else is signed in (`completeLogin`).
 */
export async function loginSubmit(
  event: RequestEvent,
  payload: LoginPayload
): Promise<LoginResult> {
  const db = getDb();
  const kr = keyringFromEnv(env);
  const resolved = await resolveClient(kr, paramsFromPayload(payload));
  const { dictionary } = await loadBranding(db);
  const checked = await checkPassword(db, payload);
  if (checked === null) {
    return { message: dictionary.login.invalid, email: payload.email };
  }
  const { user, account, email } = checked;
  const client = resolved
    ? { authorize: resolved.authorize, clientName: resolved.meta.name }
    : null;
  const status = await mfaMethods(db, user.id);
  if (hasMfa(status) || (await mfaRequired(db, user.role))) {
    return beginSecondFactor(
      event,
      { purpose: 'oauth', userId: user.id, account, email, client },
      status
    );
  }
  limiter.loginSucceeded(account);
  return completeLogin(event, user.id, client);
}
