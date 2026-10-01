import { authorizationResponseUrl } from './authorizationResponse.js';
import type { AuthCodeStore } from './codes.js';
import type { PendingAuthorize } from './ssoCookie.js';

/**
 * Where a completed login sends the browser: a fresh authorization code at the outer OAuth
 * client's `redirectUri` when this login was started for one (§5.2 "UIs … authenticate through
 * the code flow like any other client"), else the post-login landing page.
 */
export function loginRedirect(
  codes: AuthCodeStore,
  userId: string,
  authorizeParams: PendingAuthorize | null,
  origin: string
): string {
  if (authorizeParams === null) {
    return new URL('/auth/done', origin).toString();
  }
  const code = codes.issue({
    userId,
    clientId: authorizeParams.clientId,
    redirectUri: authorizeParams.redirectUri,
    redirectUriDefaulted: authorizeParams.redirectUriDefaulted === true,
    codeChallenge: authorizeParams.codeChallenge,
    scope: authorizeParams.scope
  });
  return authorizationResponseUrl(authorizeParams, origin, { code });
}
