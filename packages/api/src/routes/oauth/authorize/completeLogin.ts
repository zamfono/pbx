import { redirect, type RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import { HTTP_FOUND } from '@zamfono/shared';

import { authCodeStore } from '#lib/server/auth/codes.js';
import { CONSENT_COOKIE } from '#lib/server/auth/consent.js';
import { loginRedirect } from '#lib/server/auth/loginRedirect.js';
import { setSealedCookie } from '#lib/server/auth/sealedCookie.js';
import type { PendingAuthorize } from '#lib/server/auth/ssoCookie.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

/** The consent step the page renders once the person has signed in for a client (§5.2). */
export type ConsentStep = {
  needsConsent: true;
  clientName: string;
  redirectUri: string;
  clientId: string;
  codeChallenge: string;
};

/**
 * A finished password sign-in, its second factor passed where it needs one (§5.2
 * "Authentication pages"): a bare login (no outer client) redirects straight to the post-login
 * landing page; a login for a real client seals a consent decision into the `zamfono_consent`
 * cookie and asks the page to render the consent step, so the code is minted only once the
 * person approves it.
 */
export function completeLogin(
  event: RequestEvent,
  userId: string,
  client: { authorize: PendingAuthorize; clientName: string } | null
): ConsentStep {
  const origin = originFromEnv();
  if (client === null) {
    redirect(HTTP_FOUND, loginRedirect(authCodeStore, userId, null, origin), {
      external: [origin]
    });
  }
  setSealedCookie(event.cookies, keyringFromEnv(env), CONSENT_COOKIE, {
    userId,
    clientName: client.clientName,
    authorize: client.authorize
  });
  return {
    needsConsent: true,
    clientName: client.clientName,
    redirectUri: client.authorize.redirectUri,
    clientId: client.authorize.clientId,
    codeChallenge: client.authorize.codeChallenge
  };
}
