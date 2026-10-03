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
import { matchSsoAccount } from './ssoAccount.js';

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

/** `true` while the domain of `email` matches `allowedDomain` (case-insensitive), or while
 *  `allowedDomain` is `null` (§5.2 "SSO rules": NULL accepts any domain). */
function domainAllowed(email: string, allowedDomain: string | null): boolean {
  if (allowedDomain === null) {
    return true;
  }
  return email.toLowerCase().split('@').pop() === allowedDomain.toLowerCase();
}

/** `payload`'s verified claims once its `nonce`, e-mail-verification and domain checks all
 *  pass; the specific `FinishLoginFailure` otherwise. */
function checkClaims(
  payload: JWTPayload,
  cfg: SsoConfig,
  nonce: string
): { email: string; sub: string } | FinishLoginFailure {
  if (payload.nonce !== nonce) {
    return 'nonce';
  }
  const email = emailClaim(payload, cfg.provider);
  if (email === null) {
    return 'noUser';
  }
  const { email_verified: emailVerified } = payload;
  if (cfg.provider !== 'microsoft' && emailVerified !== true) {
    return 'unverifiedEmail';
  }
  if (!domainAllowed(email, cfg.allowedDomain)) {
    return 'domain';
  }
  const sub = payload.sub;
  if (typeof sub !== 'string') {
    return 'noUser';
  }
  return { email, sub };
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
  return matchSsoAccount(db, claims.sub, claims.email);
}
