import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload
} from 'jose';
import { z } from 'zod';

import { isRecord, MS_PER_HOUR, type SsoProvider } from '@zamfono/shared';

import { pkceS256 } from '../hash.js';
import { cappedJson } from '../json.js';
import { TtlMap } from '../ttlMap.js';

const DISCOVERY_PATH = '/.well-known/openid-configuration';
// Discovery documents are cached for 1 hour (§5.2 "SSO", `discover`).
const DISCOVERY_CACHE_TTL_MS = MS_PER_HOUR;
const AUTHORIZATION_SCOPE = 'openid email profile';
const CODE_CHALLENGE_METHOD = 'S256';
const GRANT_TYPE_AUTHORIZATION_CODE = 'authorization_code';
const ID_TOKEN_ALGORITHMS = ['RS256', 'ES256', 'PS256'];
// §5.2 "Login and SSO": each request to the provider is bounded like a metadata document's fetch,
// as a person waits on it; the largest body a provider sends, Microsoft's key set, is about 13 KB.
const OIDC_TIMEOUT_MS = 5000;
const OIDC_MAX_BYTES = 65_536;

/** `url`'s response through `fetchImpl` within `OIDC_TIMEOUT_MS`, its body parsed as JSON within
 *  `OIDC_MAX_BYTES`; throws `failure` on a non-2xx status, a body over the bound or one that is not
 *  JSON, and rejects on the deadline. */
async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  failure: string
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(OIDC_TIMEOUT_MS)
  });
  const body = response.ok
    ? await cappedJson(response.body, OIDC_MAX_BYTES)
    : undefined;
  if (body === undefined) {
    await response.body?.cancel();
    throw new Error(failure);
  }
  return body;
}

/** The `/oauth/callback` path this stack registers as every upstream provider's redirect URI. */
export const SSO_CALLBACK_PATH = '/oauth/callback';

/** A tenant's upstream OpenID Connect provider (§5.2, §11.4 `sso_*` columns). */
export type SsoConfig = {
  provider: SsoProvider;
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

const DiscoveryDocumentSchema = z.object({
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  issuer: z.string()
});

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
  const parsed = DiscoveryDocumentSchema.parse(
    await fetchJson(
      fetchImpl,
      `${cfg.issuer}${DISCOVERY_PATH}`,
      {},
      `sso: discovery failed for ${cfg.issuer}`
    )
  );
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
  url.searchParams.set('code_challenge', pkceS256(codeVerifier));
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
  const response = await fetchJson(
    fetchImpl,
    disc.tokenEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    },
    `sso: token exchange failed for ${cfg.issuer}`
  );
  const idToken = isRecord(response) ? response.id_token : undefined;
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
  const jwks = (await fetchJson(
    fetchImpl,
    disc.jwksUri,
    {},
    `sso: jwks fetch failed for ${disc.jwksUri}`
  )) as JSONWebKeySet;
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
