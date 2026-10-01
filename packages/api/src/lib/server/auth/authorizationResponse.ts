/**
 * The authorization response (RFC 6749 §4.1.2, OAuth 2.1 §4.1.2): the one URL builder behind every
 * redirect back to a client's `redirect_uri`, success or error, so each carries `iss` (§5.2
 * "Authorization responses carry `iss` (RFC 9207)") and the request's `state` whenever the
 * request had one.
 */
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

const STATUS_FOUND = 302;

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

/** The stack's own issuer, which every authorization response carries as `iss` (RFC 9207). */
export function requiredOrigin(): string {
  const value = env.ORIGIN;
  if (!value) {
    throw new Error('ORIGIN environment variable is required.');
  }
  return value;
}

/** The standard OAuth 2.1 error response (§4.1.2.1), delivered to the request's own validated
 *  `redirect_uri` so the client learns the outcome on its own channel. Only for a request whose
 *  client and `redirect_uri` have been validated: one that failed on either gets a page on this
 *  origin instead, never a redirect. */
export function authorizationErrorRedirect(
  request: AuthorizationRequestEcho,
  code: string
): never {
  return redirect(
    STATUS_FOUND,
    authorizationResponseUrl(request, requiredOrigin(), { error: code })
  );
}
