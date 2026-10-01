import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { error, redirect, type RequestEvent } from '@sveltejs/kit';

import { requiredOrigin } from '#lib/auth/authorizationResponse.js';
import {
  paramsFromPayload,
  resolveClient,
  type AuthorizePayload
} from '#lib/auth/authorizeRequest.js';
import {
  discover,
  SSO_COOKIE_NAME,
  SSO_COOKIE_PATH,
  ssoConfigFromSettings,
  startLogin
} from '#lib/auth/sso.js';
import {
  PENDING_LOGIN_TTL_S,
  sealedPendingLoginValue
} from '#lib/auth/ssoCookie.js';
import { getDb } from '#lib/db.js';
import { keyringFromEnv } from '#lib/secretbox.js';

const STATUS_BAD_REQUEST = 400;
const STATUS_FOUND = 302;
const STATUS_SERVICE_UNAVAILABLE = 503;
const RANDOM_TOKEN_BYTES = 32;

/**
 * The SSO button (§5.2 "Login and SSO"): starts the upstream code flow, sealing this outer
 * `/oauth/authorize` request (if any) into the `zamfono_sso` cookie the callback resumes it from.
 * The client is not yet authenticated at this point, so nothing is written to `oauth_clients`
 * here; the callback seals a consent decision once `finishLogin` actually succeeds, and
 * `approveConsentSubmit` upserts the row once the person approves it, the same as a password
 * sign-in.
 */
export async function ssoSubmit(
  event: RequestEvent,
  payload: AuthorizePayload
): Promise<never> {
  const db = getDb();
  const kr = keyringFromEnv(process.env);
  const origin = requiredOrigin();
  const resolved = await resolveClient(kr, paramsFromPayload(payload));
  const cfg = await ssoConfigFromSettings(db, kr);
  if (cfg === null) {
    error(STATUS_BAD_REQUEST, 'oauth/authorize: SSO is not configured');
  }
  const disc = await discover(cfg).catch(() => {
    error(
      STATUS_SERVICE_UNAVAILABLE,
      'oauth/authorize: identity provider unreachable'
    );
  });
  const state = randomBytes(RANDOM_TOKEN_BYTES).toString('base64url');
  const nonce = randomBytes(RANDOM_TOKEN_BYTES).toString('base64url');
  const codeVerifier = randomBytes(RANDOM_TOKEN_BYTES).toString('base64url');
  const { url } = startLogin(cfg, disc, origin, state, nonce, codeVerifier);
  event.cookies.set(
    SSO_COOKIE_NAME,
    sealedPendingLoginValue({
      state,
      nonce,
      codeVerifier,
      authorizeParams: resolved?.authorize ?? null
    }),
    {
      path: SSO_COOKIE_PATH,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: PENDING_LOGIN_TTL_S
    }
  );
  redirect(STATUS_FOUND, url);
}
