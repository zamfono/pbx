/**
 * The `zamfono_sso` cookie (§5.2 "Login and SSO"): the state, nonce and PKCE verifier `startLogin`
 * generated, plus the `/oauth/authorize` request the login is resuming. Sealed with the Keyring so
 * only the browser it was set on can redeem it — a `code`/`state` pair carries no redeemable login
 * without the cookie.
 */
import { z } from 'zod';

import { MS_PER_SECOND } from '@zamfono/shared';

import { decrypt, encrypt, keyringFromEnv } from '../secretbox.js';

/** How long a pending SSO login lasts: it survives the round trip to the IdP's own login and MFA
 *  pages, far longer than the 60 s an authorization code lives. */
export const PENDING_LOGIN_TTL_S = 600;
/** The cookie the pending login is sealed into (§5.2 "SSO"). */
export const SSO_COOKIE_NAME = 'zamfono_sso';
/** The `Path` the `zamfono_sso` cookie is scoped to, also used to clear it after redemption. */
export const SSO_COOKIE_PATH = '/oauth';

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

/** The login `startLogin` started: `state`, `nonce` and `codeVerifier` it generated, plus the
 *  outer `/oauth/authorize` request the login is resuming, if any. Sealed into the `zamfono_sso`
 *  cookie so only the browser it was set on can redeem it — a `code`/`state` pair carries no
 *  redeemable login without that cookie. */
export type PendingLogin = {
  state: string;
  nonce: string;
  codeVerifier: string;
  authorizeParams: PendingAuthorize | null;
};

const PendingLoginSchema = z.object({
  state: z.string(),
  nonce: z.string(),
  codeVerifier: z.string(),
  authorizeParams: PendingAuthorizeSchema.nullable()
});

// The lifetime travels inside the sealed payload, where the client cannot reach it: a cookie's
// own `Max-Age` is a request the browser makes, and a replayed cookie value carries none at all.
const SealedPendingLoginSchema = PendingLoginSchema.extend({
  expiresAtS: z.number()
});

/** `pending` sealed, with its expiry, as the bare `zamfono_sso` cookie value (§5.2 "Login and
 *  SSO"), for a caller that sets the cookie through `event.cookies`. */
export function sealedPendingLoginValue(
  pending: PendingLogin,
  nowMs = Date.now()
): string {
  const kr = keyringFromEnv(process.env);
  const expiresAtS = Math.floor(nowMs / MS_PER_SECOND) + PENDING_LOGIN_TTL_S;
  const sealed = { ...pending, expiresAtS };
  return encrypt(kr, JSON.stringify(sealed)).toString('base64url');
}

/** Seals `pending` into the `Set-Cookie` value of `zamfono_sso` (§5.2 "SSO"): HttpOnly, Secure,
 *  SameSite=Lax, scoped to `/oauth`, expiring with the pending login itself. A caller with an
 *  outer `/oauth/authorize` request to resume seals it in via `authorizeParams` afterwards. */
export function sealPendingLogin(
  pending: PendingLogin,
  nowMs = Date.now()
): string {
  const value = sealedPendingLoginValue(pending, nowMs);
  return `${SSO_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${SSO_COOKIE_PATH}; Max-Age=${PENDING_LOGIN_TTL_S}`;
}

/**
 * Unseals the `zamfono_sso` cookie value the browser presents at the callback. `null` while
 * `cookieValue` is absent, past its sealed expiry, was sealed under a key no longer in the
 * keyring, or fails to parse as a `PendingLogin` — the callback reports every case the same way
 * as an expired link.
 */
export function unsealPendingLogin(
  cookieValue: string | undefined,
  nowMs = Date.now()
): PendingLogin | null {
  if (cookieValue === undefined) {
    return null;
  }
  try {
    const kr = keyringFromEnv(process.env);
    const json = decrypt(kr, Buffer.from(cookieValue, 'base64url')).toString(
      'utf8'
    );
    const sealed = SealedPendingLoginSchema.parse(JSON.parse(json));
    if (sealed.expiresAtS * MS_PER_SECOND <= nowMs) {
      return null;
    }
    return {
      state: sealed.state,
      nonce: sealed.nonce,
      codeVerifier: sealed.codeVerifier,
      authorizeParams: sealed.authorizeParams
    };
  } catch {
    return null;
  }
}
