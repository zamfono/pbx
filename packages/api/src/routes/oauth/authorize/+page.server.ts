import * as env from '$app/env/private';

import { resolveClient, ssoInfo } from '#lib/server/auth/authorizeRequest.js';
import { CONSENT_COOKIE } from '#lib/server/auth/consent.js';
import { relayConfigured } from '#lib/server/auth/passwordReset.js';
import { unsealCookie } from '#lib/server/auth/sealedCookie.js';
import { getDb } from '#lib/server/db.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import type { PageServerLoad } from './$types.js';
import { consentForRequest } from './consentSubmit.js';

/**
 * `GET /oauth/authorize`: login-and-consent page data (§5.2 "Authentication pages"). A
 * `zamfono_consent` cookie sealed for this very request — set by the login form, or by the SSO
 * callback once a sign-in for an outer client has actually succeeded — renders the consent step
 * directly, the same one a password login reaches through the form's own result; every other
 * request resolves the outer client from the query string as usual, for the initial login form.
 */
export const load = (async event => {
  const db = getDb();
  const kr = keyringFromEnv(env);
  const mailConfigured = await relayConfigured(db);
  const sso = await ssoInfo(db, kr);
  const pendingConsent = consentForRequest(
    unsealCookie(event.cookies, kr, CONSENT_COOKIE),
    event.url.searchParams
  );
  if (pendingConsent !== null) {
    return {
      mailConfigured,
      clientName: pendingConsent.clientName,
      sso,
      authorize: null,
      consent: {
        clientName: pendingConsent.clientName,
        redirectUri: pendingConsent.authorize.redirectUri,
        clientId: pendingConsent.authorize.clientId,
        codeChallenge: pendingConsent.authorize.codeChallenge
      }
    };
  }
  const resolved = await resolveClient(kr, event.url.searchParams);
  return {
    mailConfigured,
    clientName: resolved?.meta.name ?? null,
    sso,
    authorize: resolved?.authorize ?? null,
    consent: null
  };
}) satisfies PageServerLoad;
