/**
 * The `zamfono_sso` cookie (§5.2 "Login and SSO"): the state, nonce and PKCE verifier the SSO
 * button generated, plus the `/oauth/authorize` request the login is resuming. Sealed with the
 * Keyring (`sealedCookie.ts`) so only the browser it was set on can redeem it — a `code`/`state`
 * pair carries no redeemable login without the cookie.
 */
import { z } from 'zod';

import type { SealedCookie } from './sealedCookie.js';

/** The outer `/oauth/authorize` request resumed at `redirectUri` after a successful login (§5.2
 *  "Authentication pages"). `state` is `null` for a request that sent none: OAuth 2.1 makes it
 *  optional once PKCE carries the CSRF protection, and the response then omits it too.
 *  `redirectUriDefaulted` marks a request that sent no `redirect_uri`, which OAuth 2.1 §2.3.2
 *  allows for a client with a single registered URI: `redirectUri` is then that URI. */
export const PendingAuthorizeSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  redirectUriDefaulted: z.literal(true).optional(),
  codeChallenge: z.string(),
  scope: z.string(),
  state: z.string().nullable()
});

export type PendingAuthorize = z.infer<typeof PendingAuthorizeSchema>;

const PendingLoginSchema = z.object({
  state: z.string(),
  nonce: z.string(),
  codeVerifier: z.string(),
  authorizeParams: PendingAuthorizeSchema.nullable()
});

/** The login the SSO button started: the `state`, `nonce` and `codeVerifier` it generated, plus
 *  the outer `/oauth/authorize` request the login is resuming, if any. */
export type PendingLogin = z.infer<typeof PendingLoginSchema>;

/** The `zamfono_sso` cookie, scoped to `/oauth`. It lasts 600 s: the login survives the round
 *  trip to the IdP's own login and MFA pages, far longer than the 60 s an authorization code
 *  lives. */
export const SSO_COOKIE: SealedCookie<PendingLogin> = {
  name: 'zamfono_sso',
  path: '/oauth',
  ttlS: 600,
  schema: PendingLoginSchema
};
