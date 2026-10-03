import { error } from '@sveltejs/kit';
import { z } from 'zod';

import { HTTP_BAD_REQUEST, type Db } from '@zamfono/shared';

import type { Keyring } from '../secretbox.js';
import {
  authorizationErrorRedirect,
  originFromEnv
} from './authorizationResponse.js';
import {
  decodeMetadataClientId,
  fetchCimd,
  redirectUriAllowed,
  type ClientMeta
} from './clients.js';
import { requestedResourceAcceptable } from './resource.js';
import { ssoConfigFromSettings, type PendingAuthorize } from './sso.js';

// §5.2 "Authentication pages": the server "implements the authorization-code grant with PKCE";
// the discovery document advertises only these as supported (`oauth.ts`), so a request naming
// anything else is refused before the person ever sees the login form, rather than only failing
// later at the token endpoint.
const VALID_RESPONSE_TYPE = 'code';
const VALID_CODE_CHALLENGE_METHOD = 'S256';

/** A metadata `client_id` (§5.2 "Client registration" mechanism 2) is HTTPS-URL-shaped; every
 *  other `client_id` is a Client ID Metadata Document URL (mechanism 1) instead. */
export const HTTPS_PREFIX = 'https://';

const AUTHORIZE_PARAM_NAMES = [
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'scope'
] as const;

/* eslint-disable camelcase -- RFC 6749 mandates these snake_case wire fields */
/** The outer authorization request as the login and SSO forms carry it: one hidden field per
 *  §5.2 client parameter, each absent for a bare login that names no client. */
export const AuthorizePayloadSchema = z.object({
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  scope: z.string().optional()
});
/* eslint-enable camelcase -- RFC 6749 mandates these snake_case wire fields */

export type AuthorizePayload = z.infer<typeof AuthorizePayloadSchema>;

/** `event.url.searchParams`'s hidden-field twin from a form submission (§5.2 "Authentication
 *  pages"), so one `resolveClient` serves the GET and the two POSTs alike. The form exists only
 *  for a request whose GET passed `resolveClient`, so it carries no `response_type` (nor a
 *  `code_challenge_method`): the one value that check admits, `code`, is restored here. */
export function paramsFromPayload(payload: AuthorizePayload): URLSearchParams {
  // eslint-disable-next-line camelcase -- RFC 6749 mandates this snake_case wire field
  const params = new URLSearchParams({ response_type: VALID_RESPONSE_TYPE });
  for (const name of AUTHORIZE_PARAM_NAMES) {
    const value = payload[name];
    if (value !== undefined && value !== '') {
      params.set(name, value);
    }
  }
  return params;
}

/** The request's `state`, `null` when it sent none. OAuth 2.1 §4.1.1 makes `state` optional, since
 *  PKCE already binds the code to the client that asked for it; an empty value counts as none,
 *  the same as the login form's hidden fields do (`paramsFromPayload`). */
export function requestState(params: URLSearchParams): string | null {
  const state = params.get('state');
  return state === null || state === '' ? null : state;
}

/** `clientId`'s metadata, decoded (mechanism 2) or fetched (mechanism 1); `null` for an unknown
 *  or unreachable client (§5.2 "Client registration"). */
export async function clientMetaFor(
  kr: Keyring,
  clientId: string
): Promise<ClientMeta | null> {
  return clientId.startsWith(HTTPS_PREFIX)
    ? fetchCimd(clientId)
    : decodeMetadataClientId(kr, clientId);
}

/**
 * The request's `redirect_uri`, validated against `meta`, or `null` when it cannot be trusted:
 * absent while the client registered several (OAuth 2.1 §2.3.2: "If only a single redirect URI
 * has been registered to a client, the redirect_uri request parameter is optional"), or not
 * registered at all.
 */
function validatedRedirectUri(
  meta: ClientMeta,
  params: URLSearchParams
): Pick<PendingAuthorize, 'redirectUri' | 'redirectUriDefaulted'> | null {
  const redirectUri = params.get('redirect_uri');
  if (redirectUri === null) {
    const [only, ...rest] = meta.redirectUris;
    return only !== undefined && rest.length === 0
      ? { redirectUri: only, redirectUriDefaulted: true }
      : null;
  }
  return redirectUriAllowed(meta, redirectUri) ? { redirectUri } : null;
}

/**
 * Resolves and validates the outer `/oauth/authorize` request's client (§5.2 "Client
 * registration", "Client rows"): `null` for a bare login with no `client_id`; otherwise the
 * client's metadata and the `PendingAuthorize` to resume after login.
 *
 * An unknown client, or a `redirect_uri` {@link validatedRedirectUri} refuses, is a thrown
 * `error(400)` — never a redirect, since the `redirect_uri` is exactly what could not be trusted.
 * Every later failure is the OAuth 2.1 error response at that validated `redirect_uri`
 * (§4.1.2.1), carrying `iss` like every authorization response (§5.2): a missing `response_type`
 * too, which OAuth 2.1 §4.1.1 makes required.
 */
export async function resolveClient(
  kr: Keyring,
  params: URLSearchParams
): Promise<{ meta: ClientMeta; authorize: PendingAuthorize } | null> {
  const clientId = params.get('client_id');
  if (clientId === null) {
    return null;
  }
  const meta = await clientMetaFor(kr, clientId);
  if (meta === null) {
    error(HTTP_BAD_REQUEST, 'oauth/authorize: unknown client');
  }
  const redirect = validatedRedirectUri(meta, params);
  if (redirect === null) {
    error(
      HTTP_BAD_REQUEST,
      params.has('redirect_uri')
        ? 'oauth/authorize: redirect_uri not allowed for this client'
        : 'oauth/authorize: missing redirect_uri'
    );
  }
  const { redirectUri } = redirect;
  const state = requestState(params);
  const responseType = params.get('response_type');
  if (responseType === null) {
    authorizationErrorRedirect({ redirectUri, state }, 'invalid_request');
  }
  if (responseType !== VALID_RESPONSE_TYPE) {
    authorizationErrorRedirect(
      { redirectUri, state },
      'unsupported_response_type'
    );
  }
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  if (
    codeChallenge === null ||
    (codeChallengeMethod !== null &&
      codeChallengeMethod !== VALID_CODE_CHALLENGE_METHOD)
  ) {
    authorizationErrorRedirect({ redirectUri, state }, 'invalid_request');
  }
  // RFC 8707 §2: a `resource` this server issues no tokens for is refused as `invalid_target`
  // before the person logs in; the token request checks it again (`tokenEndpoint.ts`).
  if (!requestedResourceAcceptable(originFromEnv(), params)) {
    authorizationErrorRedirect({ redirectUri, state }, 'invalid_target');
  }
  return {
    meta,
    authorize: {
      clientId,
      ...redirect,
      codeChallenge,
      scope: params.get('scope') ?? '',
      state
    }
  };
}

/** The SSO button's label, or `null` while no provider is configured (§5.2 "Login and SSO"). */
export async function ssoInfo(
  db: Db,
  kr: Keyring
): Promise<{ label: string } | null> {
  const cfg = await ssoConfigFromSettings(db, kr);
  return cfg === null ? null : { label: cfg.label };
}

/** The user row `/oauth/authorize`'s login and consent steps authenticate and redeem against. */
export async function lookupUser(
  db: Db,
  email: string
): Promise<{ id: string; passwordHash: string | null } | undefined> {
  return db
    .selectFrom('users')
    .select(['id', 'passwordHash'])
    .where('email', '=', email)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
}
