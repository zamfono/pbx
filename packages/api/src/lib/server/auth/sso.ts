/**
 * The SSO login as the routes see it (§5.2 "Login and SSO"): `finishLogin` checks the upstream
 * `id_token`'s claims and resolves the account. The rest of the flow lives beside it: discovery
 * and the upstream request (`oidc.ts`), the `zamfono_sso` cookie (`ssoCookie.ts`) and the
 * tenant's configuration (`ssoSettings.ts`).
 */
import type { JWTPayload } from 'jose';

import type { Db } from '@zamfono/shared';

import {
  emailClaim,
  exchangeIdToken,
  verifyIdToken,
  type Discovery,
  type SsoConfig
} from './oidc.js';
import { matchSsoAccount, type SsoClaims } from './ssoAccount.js';

type FinishLoginFailure =
  | 'issuer'
  | 'audience'
  | 'signature'
  | 'expired'
  | 'nonce'
  | 'unverifiedEmail'
  | 'domain'
  | 'noUser'
  | 'subMismatch';

type FinishLoginResult =
  { ok: true; userId: string } | { ok: false; reason: FinishLoginFailure };

/** `true` while `allowedDomain` is `null` (§5.2 "SSO rules": NULL accepts any domain), or while
 *  the domain of `email` matches it (case-insensitive) and, for `google`, so does the token's
 *  `hd`, the Workspace the account belongs to: a private Google account registered under a
 *  company address carries none. */
function domainAllowed(
  payload: JWTPayload,
  email: string | null,
  cfg: SsoConfig
): boolean {
  if (cfg.allowedDomain === null) {
    return true;
  }
  const allowed = cfg.allowedDomain.toLowerCase();
  if (email?.toLowerCase().split('@').pop() !== allowed) {
    return false;
  }
  return (
    cfg.provider !== 'google' ||
    (typeof payload.hd === 'string' && payload.hd.toLowerCase() === allowed)
  );
}

/** `payload`'s claims once its `nonce` and domain checks pass, with whether the issuer vouches
 *  for its e-mail (§5.2: `email_verified` for `google` and `oidc`, the pinned tenant for
 *  `microsoft`); the specific `FinishLoginFailure` otherwise. */
function checkClaims(
  payload: JWTPayload,
  cfg: SsoConfig,
  nonce: string
): SsoClaims | FinishLoginFailure {
  if (payload.nonce !== nonce) {
    return 'nonce';
  }
  const email = emailClaim(payload, cfg.provider);
  if (!domainAllowed(payload, email, cfg)) {
    return 'domain';
  }
  const sub = payload.sub;
  if (typeof sub !== 'string') {
    return 'noUser';
  }
  const emailVouched =
    cfg.provider === 'microsoft' || payload.email_verified === true;
  return { sub, email, emailVouched };
}

/** What the SSO callback hands `finishLogin`: the upstream code and the login's own values. */
export type FinishLoginParams = {
  code: string;
  codeVerifier: string;
  nonce: string;
  origin: string;
  now: string;
};

/**
 * Completes an SSO login: exchanges `params.code`, validates the `id_token` and binds or matches
 * the user (§5.2 "SSO rules", every bullet).
 */
export async function finishLogin(
  db: Db,
  cfg: SsoConfig,
  disc: Discovery,
  params: FinishLoginParams,
  fetchImpl: typeof fetch = fetch
): Promise<FinishLoginResult> {
  const idToken = await exchangeIdToken(cfg, disc, params, fetchImpl);
  const verified = await verifyIdToken(
    idToken,
    cfg,
    disc,
    params.now,
    fetchImpl
  );
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }
  const claims = checkClaims(verified.payload, cfg, params.nonce);
  if (typeof claims === 'string') {
    return { ok: false, reason: claims };
  }
  return matchSsoAccount(db, claims);
}
