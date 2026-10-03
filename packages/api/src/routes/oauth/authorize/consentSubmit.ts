import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import pino from 'pino';

import { HTTP_BAD_REQUEST, HTTP_FOUND, nowIso } from '@zamfono/shared';

import {
  authorizationErrorRedirect,
  originFromEnv
} from '#lib/server/auth/authorizationResponse.js';
import {
  clientMetaFor,
  requestState
} from '#lib/server/auth/authorizeRequest.js';
import { upsertClient } from '#lib/server/auth/clients.js';
import { authCodeStore } from '#lib/server/auth/codes.js';
import {
  CONSENT_COOKIE,
  type PendingConsent
} from '#lib/server/auth/consent.js';
import { loginRedirect } from '#lib/server/auth/loginRedirect.js';
import { unsealCookie } from '#lib/server/auth/sealedCookie.js';
import { getDb } from '#lib/server/db.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

const ACCESS_DENIED = 'access_denied';
const SERVER_ERROR = 'server_error';
const logger = pino({ name: 'oauth-authorize' });

type Authorize = PendingConsent['authorize'];

/** The sealed request and `params` name one and the same authorization request. */
function sameRequest(authorize: Authorize, params: URLSearchParams): boolean {
  return (
    authorize.clientId === params.get('client_id') &&
    (authorize.redirectUriDefaulted === true ? null : authorize.redirectUri) ===
      params.get('redirect_uri') &&
    authorize.codeChallenge === params.get('code_challenge') &&
    authorize.state === requestState(params) &&
    authorize.scope === (params.get('scope') ?? '')
  );
}

/**
 * `pending` for the request `params` describes, `null` for any other one (§5.2 "Authentication
 * pages"). The SSO callback returns to a bare `/oauth/authorize`, and the password form re-renders
 * the request's own query string, so a `client_id` the seal does not carry belongs to a different
 * authorization request — one that resolves on its own and gets its own login step, since the
 * code a consent step mints is minted for the client the seal names.
 */
export function consentForRequest(
  pending: PendingConsent | null,
  params: URLSearchParams
): PendingConsent | null {
  if (pending === null || params.get('client_id') === null) {
    return pending;
  }
  return sameRequest(pending.authorize, params) ? pending : null;
}

/** The sealed decision this consent step acts on, consumed: the cookie is dropped either way, so
 *  a reload cannot approve twice. A cookie that is absent, sealed under a retired key or
 *  malformed reads as an expired session. */
function takePendingConsent(event: RequestEvent): PendingConsent {
  const pending = unsealCookie(
    event.cookies,
    keyringFromEnv(env),
    CONSENT_COOKIE
  );
  event.cookies.delete(CONSENT_COOKIE.name, { path: CONSENT_COOKIE.path });
  if (pending === null) {
    error(HTTP_BAD_REQUEST, 'oauth/authorize: consent session expired');
  }
  return pending;
}

/** Writes the client's `oauth_clients` row, `false` when it cannot be written. */
async function writeClientRow(authorize: Authorize): Promise<boolean> {
  const meta = await clientMetaFor(keyringFromEnv(env), authorize.clientId);
  if (meta === null) {
    logger.warn(
      { clientId: authorize.clientId },
      'oauth/authorize: client metadata unresolvable at consent'
    );
    return false;
  }
  return upsertClient(getDb(), meta, nowIso()).then(
    () => true,
    (err: unknown) => {
      logger.error({ err }, 'oauth/authorize: client row could not be written');
      return false;
    }
  );
}

/**
 * The consent step's approve button: mints the authorization code only now, the first point at
 * which the person has both authenticated and approved this client — whether the sign-in was by
 * password or SSO — so `oauth_clients` is upserted here too (§5.2 "Client rows": "on the first
 * successful authorization"). `tokens.client_id` references that row (§11.2), so a client whose
 * row cannot be written gets the OAuth `server_error` response rather than a code the token
 * exchange could not redeem.
 */
export async function approveConsentSubmit(
  event: RequestEvent
): Promise<never> {
  const pending = takePendingConsent(event);
  if (!(await writeClientRow(pending.authorize))) {
    authorizationErrorRedirect(pending.authorize, SERVER_ERROR);
  }
  redirect(
    HTTP_FOUND,
    loginRedirect(
      authCodeStore,
      pending.userId,
      pending.authorize,
      originFromEnv()
    ),
    { external: true }
  );
}

/** The consent step's deny button: no code is ever minted, and the client learns why through the
 *  standard OAuth 2.1 error redirect rather than a page on this origin. `async` even without an
 *  `await`, so `redirect()`'s throw becomes a rejected promise like every other handler here,
 *  rather than an exception a caller's `.catch()` never gets the chance to see. */
// eslint-disable-next-line @typescript-eslint/require-await -- see above: the `async` itself is the point
export async function denyConsentSubmit(event: RequestEvent): Promise<never> {
  const pending = takePendingConsent(event);
  authorizationErrorRedirect(pending.authorize, ACCESS_DENIED);
}
