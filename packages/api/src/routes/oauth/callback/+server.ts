import { redirect, type RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';
import pino from 'pino';

import { HTTP_FOUND, nowIso, type Db } from '@zamfono/shared';

import { clientMetaFor } from '#lib/server/auth/clients.js';
import { authCodeStore } from '#lib/server/auth/codes.js';
import { CONSENT_COOKIE } from '#lib/server/auth/consent.js';
import { loginRedirect } from '#lib/server/auth/loginRedirect.js';
import {
  discover,
  type Discovery,
  type SsoConfig
} from '#lib/server/auth/oidc.js';
import {
  setSealedCookie,
  unsealCookie
} from '#lib/server/auth/sealedCookie.js';
import { finishLogin, type FinishLoginParams } from '#lib/server/auth/sso.js';
import { SSO_COOKIE } from '#lib/server/auth/ssoCookie.js';
import { ssoConfigFromSettings } from '#lib/server/auth/ssoSettings.js';
import { getDb } from '#lib/server/db.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { originFromEnv } from '#lib/server/stackAddress.js';

type FinishLoginResult = Awaited<ReturnType<typeof finishLogin>>;

const logger = pino({ name: 'oauth-callback' });

/** Redirects to the error page (§5.2 "Authentication pages": "a plain error page for … an
 *  expired link"), naming the refusal so the page can render an accurate message. */
function toErrorPage(origin: string, reason: string): never {
  const url = new URL('/auth/error', origin);
  url.searchParams.set('reason', reason);
  return redirect(HTTP_FOUND, url.toString(), { external: [origin] });
}

/** The reason shown on the error page: a `subMismatch` is reported as `noUser` there too, so an
 *  unauthenticated visitor cannot use the two to tell whether an e-mail belongs to a live
 *  account (§5.2 "SSO rules": a sub mismatch is refused and logged, not disclosed). */
function publicReason(reason: string): string {
  return reason === 'subMismatch' ? 'noUser' : reason;
}

/** `discover`, mapping a provider-side discovery failure to the error page instead of a 500: the
 *  provider being unreachable or misconfigured is indistinguishable, to the person waiting on the
 *  redirect, from the link they followed having expired. */
async function discoverOrErrorPage(
  cfg: SsoConfig,
  origin: string
): Promise<Discovery> {
  try {
    return await discover(cfg);
  } catch (err) {
    logger.warn({ err }, 'sso: discovery failed');
    return toErrorPage(origin, 'expired');
  }
}

/** `finishLogin`, mapping a thrown token-exchange or `id_token` verification failure (an expired
 *  or already-redeemed code looks the same to this handler) to the error page the same way. A
 *  `FinishLoginFailure` result is returned as-is, for the caller to redirect on. */
async function finishLoginOrErrorPage(
  db: Db,
  cfg: SsoConfig,
  disc: Discovery,
  params: FinishLoginParams,
  origin: string
): Promise<FinishLoginResult> {
  try {
    return await finishLogin(db, cfg, disc, params);
  } catch (err) {
    logger.warn({ err }, 'sso: token exchange or id_token verification failed');
    return toErrorPage(origin, 'expired');
  }
}

/**
 * `GET /oauth/callback`: the OIDC return handler for every configured SSO provider (§5.2 "Login
 * and SSO"). The browser presents the `zamfono_sso` cookie the SSO button set on
 * `/oauth/authorize`, sealing the nonce and PKCE verifier it generated and never put on the wire,
 * and the outer authorize request, if any, alongside them; its `state` must equal the
 * query's, so a `code`/`state` pair copied off the browser that started the login is refused on
 * any other browser. On success, a sign-in for an outer client seals a consent decision into the
 * `zamfono_consent` cookie and returns to `/oauth/authorize` to render the consent step naming
 * that client, the same as the password form (§5.2 "Authentication pages": "a consent step naming
 * the requesting client"); a sign-in without one goes straight to the post-login page.
 */
export async function GET(event: RequestEvent): Promise<Response> {
  const origin = originFromEnv();
  const kr = keyringFromEnv(env);
  const state = event.url.searchParams.get('state');
  const code = event.url.searchParams.get('code');
  if (!state || !code) {
    toErrorPage(origin, 'expired');
  }
  const pending = unsealCookie(event.cookies, kr, SSO_COOKIE);
  if (pending?.state !== state) {
    toErrorPage(origin, 'expired');
  }
  event.cookies.delete(SSO_COOKIE.name, { path: SSO_COOKIE.path });

  const db = getDb();
  const cfg = await ssoConfigFromSettings(db, kr);
  if (!cfg) {
    toErrorPage(origin, 'noUser');
  }
  const disc = await discoverOrErrorPage(cfg, origin);
  const result = await finishLoginOrErrorPage(
    db,
    cfg,
    disc,
    {
      code,
      codeVerifier: pending.codeVerifier,
      nonce: pending.nonce,
      origin,
      now: nowIso()
    },
    origin
  );
  if (!result.ok) {
    toErrorPage(origin, publicReason(result.reason));
  }
  if (pending.authorizeParams === null) {
    redirect(
      HTTP_FOUND,
      loginRedirect(authCodeStore, result.userId, null, origin),
      { external: [origin] }
    );
  }
  // A client re-resolution failure here (an expired CIMD cache entry gone stale mid-flow) cannot
  // name the client on the consent step, so it is reported the same way an expired link is.
  const meta = await clientMetaFor(kr, pending.authorizeParams.clientId);
  if (meta === null) {
    toErrorPage(origin, 'expired');
  }
  setSealedCookie(event.cookies, kr, CONSENT_COOKIE, {
    userId: result.userId,
    clientName: meta.name,
    authorize: pending.authorizeParams
  });
  redirect(HTTP_FOUND, new URL('/oauth/authorize', origin).toString(), {
    external: [origin]
  });
}
