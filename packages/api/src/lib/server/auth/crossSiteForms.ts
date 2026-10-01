/**
 * The CSRF origin check for the browser-served pages (§5.2 "Authentication pages"), which
 * `hooks.server.ts` applies in place of SvelteKit's built-in one (`svelte.config.js` turns that
 * off). SvelteKit's check covers every route alike, so it also refused the endpoints the spec
 * defines for non-browser clients, which send no `Origin` at all: the form-encoded
 * `/oauth/token` and `/oauth/revoke` (RFC 6749 §3.2, RFC 7009 §2.1), and a bearer-authenticated
 * multipart upload such as `POST /api/v1/audio` (§10.3). This check is SvelteKit's own rule with
 * those endpoints left out, so the remote forms of the login, consent, forgot-password and
 * set-password pages stay exactly as protected as before, whether a submission posts to the page
 * itself (no JavaScript; the login and consent submissions carry the `zamfono_consent` cookie)
 * or to SvelteKit's `/_app/remote/…` endpoint.
 */
import { requiredOrigin } from './authorizationResponse.js';

const STATUS_FORBIDDEN = 403;

// The encodings an HTML form can submit cross-site without a CORS preflight, plus the one
// SvelteKit's own enhanced forms use; the same list SvelteKit's check guards.
const FORM_CONTENT_TYPES = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'application/x-sveltekit-formdata'
]);

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The client endpoints (§5.2, §10.3, §10.5): none reads a cookie, so a cross-site form gains no
// ambient authority there. REST authenticates by bearer token, the OAuth endpoints by the grant
// or token in the body, and `/mcp` validates `Origin` itself (`$lib/server/mcp/origin.ts`).
const CLIENT_PATHS = new Set([
  '/oauth/token',
  '/oauth/revoke',
  '/oauth/register',
  '/mcp'
]);
const CLIENT_PREFIX = '/api/v1/';
// The stack's own callers (§3.1): the `proxy` image's certificate hook posts to
// `/internal/certificate` with BusyBox `wget --post-data`, which sends a form content type and
// no `Origin`. Nothing there reads a cookie, and Caddy answers 404 for the whole prefix, so no
// browser reaches it.
const INTERNAL_PREFIX = '/internal/';

function isClientEndpoint(pathname: string): boolean {
  return (
    CLIENT_PATHS.has(pathname) ||
    pathname.startsWith(CLIENT_PREFIX) ||
    pathname.startsWith(INTERNAL_PREFIX)
  );
}

function isFormSubmission(request: Request): boolean {
  const type =
    request.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
  return (
    UNSAFE_METHODS.has(request.method) &&
    FORM_CONTENT_TYPES.has(type.toLowerCase())
  );
}

/** The 403 refusing a form submission to a browser-served route whose `Origin` is missing or
 *  is not the stack's own, else `null` to let the request through. */
export function crossSiteFormRejection(
  request: Request,
  pathname: string
): Response | null {
  if (isClientEndpoint(pathname) || !isFormSubmission(request)) {
    return null;
  }
  // `Origin` is serialised canonically (RFC 6454 §6.1), so it is compared with the configured
  // value's own origin, which drops a trailing slash or path an operator may have written.
  if (request.headers.get('origin') === new URL(requiredOrigin()).origin) {
    return null;
  }
  return new Response(
    `Cross-site ${request.method} form submissions are forbidden`,
    { status: STATUS_FORBIDDEN, headers: { 'content-type': 'text/plain' } }
  );
}
