/**
 * The authorization response (RFC 6749 §4.1.2, OAuth 2.1 §4.1.2): the one URL builder behind every
 * redirect back to a client's `redirect_uri`, success or error, so each carries `iss` (§5.2
 * "Authorization responses carry `iss` (RFC 9207)") and the request's `state` whenever the
 * request had one.
 */
import { redirect } from '@sveltejs/kit';

import { HTTP_FOUND } from '@zamfono/shared';

import { originFromEnv } from '../stackAddress.js';

/** The part of the authorization request its response echoes; `state` is `null` for a request
 *  that sent none (OAuth 2.1 §4.1.1: optional). */
export type AuthorizationRequestEcho = {
  redirectUri: string;
  state: string | null;
};

/** `request.redirectUri` with `fields` (`code`, or `error`) plus `iss` (`issuer`, the stack's own
 *  origin) and, when the request carried one, `state` in its query. */
export function authorizationResponseUrl(
  request: AuthorizationRequestEcho,
  issuer: string,
  fields: Record<string, string>
): string {
  const url = new URL(request.redirectUri);
  for (const [name, value] of Object.entries(fields)) {
    url.searchParams.set(name, value);
  }
  if (request.state !== null) {
    url.searchParams.set('state', request.state);
  }
  url.searchParams.set('iss', issuer);
  return url.toString();
}

/** The standard OAuth 2.1 error response (§4.1.2.1), delivered to the request's own validated
 *  `redirect_uri` so the client learns the outcome on its own channel. Only once the person has
 *  acted on the consent step: every failure before that gets a page on this origin instead, never
 *  a redirect (§5.2, RFC 9700 §4.11.2). */
export function authorizationErrorRedirect(
  request: AuthorizationRequestEcho,
  code: string
): never {
  return redirect(
    HTTP_FOUND,
    authorizationResponseUrl(request, originFromEnv(), { error: code }),
    { external: true }
  );
}
