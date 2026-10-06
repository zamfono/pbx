import { randomBytes } from 'node:crypto';
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import {
  HTTP_BAD_REQUEST,
  HTTP_FOUND,
  HTTP_SERVICE_UNAVAILABLE
} from '@zamfono/shared';

import {
  paramsFromPayload,
  resolveClient,
  type AuthorizePayload
} from '#lib/server/auth/authorizeRequest.js';
import { discover, startLogin } from '#lib/server/auth/oidc.js';
import { setSealedCookie } from '#lib/server/auth/sealedCookie.js';
import { SSO_COOKIE } from '#lib/server/auth/ssoCookie.js';
import { ssoConfigFromSettings } from '#lib/server/auth/ssoSettings.js';
import { getDb } from '#lib/server/db.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

const RANDOM_TOKEN_BYTES = 32;

/**
 * The SSO button (§5.2 "Login and SSO"): starts the upstream code flow, sealing this outer
 * `/oauth/authorize` request (if any) into the `zamfono_sso` cookie the callback resumes it from.
 * The client is not yet authenticated at this point, so nothing is written to `oauth_clients`
 * here; the callback seals a consent decision once `finishLogin` actually succeeds, and
 * `approveConsentSubmit` upserts the row once the person approves it, the same as a password
 * sign-in. The security page's sign-in starts the same flow with `opens` `security` (§5.2).
 */
export async function ssoSubmit(
  event: RequestEvent,
  payload: AuthorizePayload,
  opens: 'login' | 'security' = 'login'
): Promise<never> {
  const db = getDb();
  const kr = keyringFromEnv(env);
  const origin = originFromEnv();
  const resolved = await resolveClient(kr, paramsFromPayload(payload));
  const cfg = await ssoConfigFromSettings(db, kr);
  if (cfg === null) {
    error(HTTP_BAD_REQUEST, 'oauth/authorize: SSO is not configured');
  }
  const disc = await discover(cfg).catch(() => {
    error(
      HTTP_SERVICE_UNAVAILABLE,
      'oauth/authorize: identity provider unreachable'
    );
  });
  const state = randomBytes(RANDOM_TOKEN_BYTES).toString('base64url');
  const nonce = randomBytes(RANDOM_TOKEN_BYTES).toString('base64url');
  const codeVerifier = randomBytes(RANDOM_TOKEN_BYTES).toString('base64url');
  setSealedCookie(event.cookies, kr, SSO_COOKIE, {
    state,
    nonce,
    codeVerifier,
    authorizeParams: resolved?.authorize ?? null,
    ...(opens === 'security' ? { security: true } : {})
  });
  redirect(
    HTTP_FOUND,
    startLogin(cfg, disc, origin, state, nonce, codeVerifier),
    { external: true }
  );
}
