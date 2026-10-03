import { createHash } from 'node:crypto';
import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload
} from 'jose';
import { z } from 'zod';

import { MS_PER_HOUR } from '@zamfono/shared';

import { TtlMap } from '../ttlMap.js';

const DISCOVERY_PATH = '/.well-known/openid-configuration';
// Discovery documents are cached for 1 hour (§5.2 "SSO", `discover`).
const DISCOVERY_CACHE_TTL_MS = MS_PER_HOUR;
const AUTHORIZATION_SCOPE = 'openid email profile';
const CODE_CHALLENGE_METHOD = 'S256';
const GRANT_TYPE_AUTHORIZATION_CODE = 'authorization_code';
const ID_TOKEN_ALGORITHMS = ['RS256', 'ES256', 'PS256'];

/** The `/oauth/callback` path this stack registers as every upstream provider's redirect URI. */
export const SSO_CALLBACK_PATH = '/oauth/callback';

/** A tenant's upstream OpenID Connect provider (§5.2, §11.4 `sso_*` columns). */
export type SsoConfig = {
  provider: 'microsoft' | 'google' | 'oidc';
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  tenantId: string | null;
  allowedDomain: string | null;
  label: string;
};

/** The subset of a provider's discovery document the code flow needs. */
export type Discovery = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuer: string;
};

const discoveryCache = new TtlMap<string, Discovery>();

/* eslint-disable camelcase -- RFC 8414/OIDC discovery mandates these snake_case wire fields */
const DiscoveryDocumentSchema = z.object({
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  issuer: z.string()
});
/* eslint-enable camelcase -- RFC 8414/OIDC discovery mandates these snake_case wire fields */

/** Fetches and caches (1 h) `cfg.issuer`'s OpenID discovery document. */
export async function discover(
  cfg: SsoConfig,
  fetchImpl: typeof fetch = fetch
): Promise<Discovery> {
  const nowMs = Date.now();
  const cached = discoveryCache.get(cfg.issuer);
  if (cached !== undefined) {
    return cached;
  }
  const response = await fetchImpl(`${cfg.issuer}${DISCOVERY_PATH}`);
  if (!response.ok) {
    throw new Error(`sso: discovery failed for ${cfg.issuer}`);
  }
  const parsed = DiscoveryDocumentSchema.parse(await response.json());
  // RFC 8414 §3.3: the tenant pinning of §5.2 "Login and SSO" requires this to match.
  if (parsed.issuer !== cfg.issuer) {
    throw new Error(`sso: discovery issuer mismatch for ${cfg.issuer}`);
  }
  const doc: Discovery = {
    authorizationEndpoint: parsed.authorization_endpoint,
    tokenEndpoint: parsed.token_endpoint,
    jwksUri: parsed.jwks_uri,
    issuer: parsed.issuer
  };
  discoveryCache.set(cfg.issuer, doc, nowMs + DISCOVERY_CACHE_TTL_MS);
  return doc;
}

/** RFC 7636 S256: `BASE64URL(SHA256(verifier))`. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** The upstream authorization URL for `state`, `nonce` and `codeVerifier`'s S256 challenge; the
 *  caller seals the three into the `zamfono_sso` cookie the callback redeems them from. */
// eslint-disable-next-line max-params -- the authorization request's own parameters (§5.2 "Login and SSO")
export function startLogin(
  cfg: SsoConfig,
  disc: Discovery,
  origin: string,
  state: string,
  nonce: string,
  codeVerifier: string
): string {
  const url = new URL(disc.authorizationEndpoint);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', `${origin}${SSO_CALLBACK_PATH}`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', AUTHORIZATION_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', s256(codeVerifier));
  url.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD);
  return url.toString();
}

/** Redeems `params.code` at the token endpoint and returns the raw `id_token`. */
export async function exchangeIdToken(
  cfg: SsoConfig,
  disc: Discovery,
  params: { code: string; codeVerifier: string; origin: string },
  fetchImpl: typeof fetch
): Promise<string> {
  // Built via `.set()`, not object-literal keys, so RFC 6749's snake_case fields need no suppression.
  const body = new URLSearchParams();
  body.set('grant_type', GRANT_TYPE_AUTHORIZATION_CODE);
  body.set('code', params.code);
  body.set('redirect_uri', `${params.origin}${SSO_CALLBACK_PATH}`);
  body.set('client_id', cfg.clientId);
  body.set('code_verifier', params.codeVerifier);
  if (cfg.clientSecret !== null) {
    body.set('client_secret', cfg.clientSecret);
  }
  const response = await fetchImpl(disc.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    throw new Error(`sso: token exchange failed for ${cfg.issuer}`);
  }
  const { id_token: idToken } = (await response.json()) as {
    id_token?: unknown;
  };
  if (typeof idToken !== 'string') {
    throw new Error(
      `sso: token response for ${cfg.issuer} carried no id_token`
    );
  }
  return idToken;
}

/** Why `verifyIdToken` rejected an `id_token`, each a distinct `FinishLoginFailure` reason. */
export type IdTokenFailure = 'issuer' | 'audience' | 'signature' | 'expired';

/** `err`, a `JOSEError` from `jwtVerify`, as the specific `IdTokenFailure` it represents: an
 *  expired token, a claim mismatch on `aud` or (by exclusion) `iss`, or, for every other
 *  verification failure (bad signature, malformed token, no matching JWKS key), `signature`. */
function idTokenFailureReason(err: joseErrors.JOSEError): IdTokenFailure {
  if (err instanceof joseErrors.JWTExpired) {
    return 'expired';
  }
  if (
    err instanceof joseErrors.JWTClaimValidationFailed &&
    err.claim === 'aud'
  ) {
    return 'audience';
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return 'issuer';
  }
  return 'signature';
}

/** Verifies `idToken`'s signature, `iss`, `aud` and expiry (as of `now`) against `disc`'s JWKS. */
export async function verifyIdToken(
  idToken: string,
  cfg: SsoConfig,
  disc: Discovery,
  now: string,
  fetchImpl: typeof fetch
): Promise<
  { ok: true; payload: JWTPayload } | { ok: false; reason: IdTokenFailure }
> {
  const jwksResponse = await fetchImpl(disc.jwksUri);
  if (!jwksResponse.ok) {
    throw new Error(`sso: jwks fetch failed for ${disc.jwksUri}`);
  }
  const jwks = (await jwksResponse.json()) as JSONWebKeySet;
  try {
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: disc.issuer,
      audience: cfg.clientId,
      algorithms: ID_TOKEN_ALGORITHMS,
      currentDate: new Date(now)
    });
    return { ok: true, payload };
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) {
      return { ok: false, reason: idTokenFailureReason(err) };
    }
    throw err;
  }
}

/** The verified e-mail claim: `email`, or Microsoft's `preferred_username` in its absence. */
export function emailClaim(
  payload: JWTPayload,
  provider: SsoConfig['provider']
): string | null {
  const email = payload.email;
  if (typeof email === 'string') {
    return email;
  }
  const { preferred_username: preferredUsername } = payload;
  if (provider === 'microsoft' && typeof preferredUsername === 'string') {
    return preferredUsername;
  }
  return null;
}
