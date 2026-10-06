import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import { z } from 'zod';

import { mfaMethods } from '@zamfono/shared';

import {
  AuthorizePayloadSchema,
  lookupUser,
  paramsFromPayload,
  resolveClient
} from '#lib/server/auth/authorizeRequest.js';
import { loadBranding } from '#lib/server/auth/branding.js';
import { hasMfa, mfaRequired } from '#lib/server/auth/mfa/status.js';
import { verifyPassword } from '#lib/server/auth/password.js';
import { getDb } from '#lib/server/db.js';
import { limiter } from '#lib/server/limiter.js';
import { accountLockKey } from '#lib/server/ops/users/_accountLock.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { completeLogin, type ConsentStep } from './completeLogin.js';
import {
  beginSecondFactor,
  type SecondFactorStep
} from './secondFactorSubmit.js';

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

// A well-formed address and a non-empty password, checked here rather than in the form schema:
// every refusal this page renders carries the same generic message (§5.5), so field-level
// validation issues would distinguish submissions that must stay indistinguishable.
const CredentialsSchema = z.object({
  email: z.email(),
  _password: z.string().min(1)
});

/**
 * The password form (§5.2 "Authentication pages", §5.5): wrong password or a locked account both
 * answer the same generic message, so neither reveals whether the account exists. A user who has
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
  const refused = { message: dictionary.login.invalid, email: payload.email };
  const parsed = CredentialsSchema.safeParse(payload);
  if (!parsed.success) {
    return refused;
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
    return refused;
  }
  const user = await lookupUser(db, email);
  const verified = await verifyPassword(user?.passwordHash ?? null, password);
  if (!verified || !user) {
    return refused;
  }
  const client = resolved
    ? { authorize: resolved.authorize, clientName: resolved.meta.name }
    : null;
  const status = await mfaMethods(db, user.id);
  if (hasMfa(status) || (await mfaRequired(db, user.role))) {
    return beginSecondFactor(
      event,
      { userId: user.id, account, email, client },
      status
    );
  }
  limiter.loginSucceeded(account);
  return completeLogin(event, user.id, client);
}
