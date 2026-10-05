import { redirect, type RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_FOUND } from '@zamfono/shared';

import {
  AuthorizePayloadSchema,
  lookupUser,
  paramsFromPayload,
  resolveClient
} from '#lib/server/auth/authorizeRequest.js';
import { loadBranding } from '#lib/server/auth/branding.js';
import { authCodeStore } from '#lib/server/auth/codes.js';
import { CONSENT_COOKIE } from '#lib/server/auth/consent.js';
import { loginRedirect } from '#lib/server/auth/loginRedirect.js';
import { verifyPassword } from '#lib/server/auth/password.js';
import { setSealedCookie } from '#lib/server/auth/sealedCookie.js';
import { getDb } from '#lib/server/db.js';
import { limiter } from '#lib/server/limiter.js';
import { accountLockKey } from '#lib/server/ops/users/_accountLock.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

/** The login form's own fields, on top of the outer request's client parameters (§5.2). The
 *  leading underscore keeps the password out of the re-rendered page: SvelteKit repopulates a
 *  non-enhanced submission's fields from the submitted values, and skips the underscored ones. */
export const LoginPayloadSchema = AuthorizePayloadSchema.extend({
  email: z.string(),
  _password: z.string(),
  action: z.enum(['password', 'sso'])
});

export type LoginPayload = z.infer<typeof LoginPayloadSchema>;

/** The page's two rendered outcomes: the generic refusal, or the consent step (§5.2). A refusal
 *  carries the submitted address back, so only the password has to be typed again. */
export type LoginResult =
  | { message: string; email: string }
  | {
      needsConsent: true;
      clientName: string;
      redirectUri: string;
      clientId: string;
      codeChallenge: string;
    };

// A well-formed address and a non-empty password, checked here rather than in the form schema:
// every refusal this page renders carries the same generic message (§5.5), so field-level
// validation issues would distinguish submissions that must stay indistinguishable.
const CredentialsSchema = z.object({
  email: z.email(),
  _password: z.string().min(1)
});

/**
 * The password form (§5.2 "Authentication pages", §5.5): wrong password or a locked account both
 * answer the same generic message, so neither reveals whether the account exists. A bare login
 * (no outer client) redirects straight to the post-login landing page; a login for a real client
 * instead seals a consent decision into the `zamfono_consent` cookie and asks the page to render
 * the consent step, so the code is minted only once the person approves it.
 */
export async function loginSubmit(
  event: RequestEvent,
  payload: LoginPayload
): Promise<LoginResult> {
  const db = getDb();
  const kr = keyringFromEnv(env);
  const origin = originFromEnv();
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
  limiter.loginSucceeded(account);
  if (!resolved) {
    redirect(HTTP_FOUND, loginRedirect(authCodeStore, user.id, null, origin), {
      external: [origin]
    });
  }
  setSealedCookie(event.cookies, kr, CONSENT_COOKIE, {
    userId: user.id,
    clientName: resolved.meta.name,
    authorize: resolved.authorize
  });
  return {
    needsConsent: true,
    clientName: resolved.meta.name,
    redirectUri: resolved.authorize.redirectUri,
    clientId: resolved.authorize.clientId,
    codeChallenge: resolved.authorize.codeChallenge
  };
}
