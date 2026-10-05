import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import * as env from '$app/env/private';
import pino from 'pino';

import {
  HTTP_NOT_FOUND,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  MS_PER_SECOND,
  stackTimeZoneError
} from '@zamfono/shared';

import { addressKey } from '#lib/server/addressKey.js';
import {
  authenticateLink,
  authenticateRequest
} from '#lib/server/auth/bearer.js';
import {
  crossSiteFormRejection,
  INTERNAL_PREFIX
} from '#lib/server/auth/crossSiteForms.js';
import { getDb } from '#lib/server/db.js';
import { startBackgroundJobs } from '#lib/server/jobs/background.js';
import { limiter, type LimitKind } from '#lib/server/limiter.js';
import { recordApiRequestSeconds } from '#lib/server/metricsCounters.js';
import { problem } from '#lib/server/problem.js';
import { API_PREFIX } from '#lib/server/restRoutes.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { stackIpv4 } from '#lib/server/stackAddress.js';

const jobsLogger = pino({ name: 'hooks' });

/**
 * Refuses to start without the mode's public address, which `src/env.ts` cannot require of either
 * variable alone; logs a stack `TZ` that names no IANA time zone, then starts every background job
 * (`lib/server/jobs/background.ts`), from this file since it is part
 * of the SvelteKit build that also builds `runOperation` and every route: a job started here
 * shares their module instance of every import, and an operation reaches it by a call, where
 * `server.ts` is a separate esbuild bundle with its own copy of every relative import. SvelteKit
 * runs it once, after validating `src/env.ts`, and serves no request before it resolves; a
 * failure of the first-boot seed rejects it, which fails loading the handler and so `api`'s boot.
 * The jobs stop on `sveltekit:shutdown`, which `server.ts` emits on SIGTERM and SIGINT. During
 * the build, which prerenders the OpenAPI document, it does nothing.
 */
export const init: ServerInit = async () => {
  if (building) {
    return;
  }
  stackIpv4(env);
  const timeZoneError = stackTimeZoneError(env.TZ);
  if (timeZoneError !== undefined) {
    jobsLogger.error(timeZoneError);
  }
  const jobs = await startBackgroundJobs(
    getDb(),
    keyringFromEnv(env),
    jobsLogger
  );
  process.once('sveltekit:shutdown', () => {
    jobs.stop();
  });
};

// The one `/api/v1/*` path served without a bearer token (§10.3).
const OPENAPI_PATH = `${API_PREFIX}/openapi.json`;

// §5.5's per-address limit for the two endpoints it can be applied to by pathname alone. The
// login and forgot-password limits key on the account the request body names, and the login's
// address limit counts submissions rather than views of the page, so both live in the handler
// that reads that body (the `login` form in `authorize.remote.ts`; `requestPasswordReset`, which
// `POST /auth/resetRequest` and the forgot-password page's form share).
const RATE_LIMITED_PATHS: Partial<Record<string, LimitKind>> = {
  '/oauth/token': 'token',
  '/oauth/register': 'register'
};

/** 429 problem+json once `pathname`'s own §5.5 address limit is exceeded, else `null` to let the request through. */
function rateLimitResponse(
  pathname: string,
  event: RequestEvent
): Response | null {
  const kind = RATE_LIMITED_PATHS[pathname];
  if (!kind) {
    return null;
  }
  const result = limiter.check(kind, addressKey(event.getClientAddress()));
  if (result.ok) {
    return null;
  }
  return problem(HTTP_TOO_MANY_REQUESTS, 'too many requests', undefined, {
    'retry-after': String(result.retryAfterS)
  });
}

// `src/app.html`'s placeholder for the page language.
const LANG_PLACEHOLDER = '%lang%';

/** Fills `<html lang>` with `settings.language`, the language every page renders in (§5.2). */
async function fillLanguage({ html }: { html: string }): Promise<string> {
  if (!html.includes(LANG_PLACEHOLDER)) {
    return html;
  }
  const { language } = await getDb()
    .selectFrom('settings')
    .select('language')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return html.replace(LANG_PLACEHOLDER, language);
}

/**
 * Refuses a cross-site form submission to a browser-served page (`crossSiteFormRejection`);
 * resolves `/api/v1/*`'s bearer token, or a download link's token (§10.5), into
 * `event.locals.auth`, 401 problem+json without one (the OpenAPI document needs neither);
 * refuses `/internal/*` when the request carries `X-Forwarded-For`, since only the proxy hop sets
 * it and that path is reachable from the internal network alone (§3.1); answers 429 problem+json
 * once a client address exceeds the §5.5 limit of the auth endpoint it called.
 */
const handleRequest: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  const crossSite = crossSiteFormRejection(event.request, pathname);
  if (crossSite) {
    return crossSite;
  }
  if (
    pathname.startsWith(INTERNAL_PREFIX) &&
    event.request.headers.has('x-forwarded-for')
  ) {
    return new Response(null, { status: HTTP_NOT_FOUND });
  }
  const limited = rateLimitResponse(pathname, event);
  if (limited) {
    return limited;
  }
  if (!pathname.startsWith(API_PREFIX) || pathname === OPENAPI_PATH) {
    event.locals.auth = null;
    return resolve(event, { transformPageChunk: fillLanguage });
  }
  const deps = { db: getDb(), jwtSecret: env.JWT_SECRET };
  const bearer = await authenticateRequest(deps, event.request);
  const link = bearer
    ? null
    : await authenticateLink(deps, 'download', event.url);
  const auth = bearer ?? link;
  if (!auth) {
    return problem(HTTP_UNAUTHORIZED, 'unauthorized');
  }
  // eslint-disable-next-line require-atomic-updates -- `event` is this call's own local object, never mutated concurrently
  event.locals.auth = auth;
  if (!link) {
    return resolve(event);
  }
  // RFC 6750 §2.3: a response to a request whose token is in the URI is kept from shared caches.
  const response = await resolve(event);
  response.headers.set('cache-control', 'private');
  return response;
};

/**
 * Runs `handleRequest`, timing it for `zamfono_api_request_seconds` (§7 "API latency")
 * regardless of which branch it returns from or whether it throws.
 */
export const handle: Handle = async input => {
  const startedAtMs = Date.now();
  try {
    return await handleRequest(input);
  } finally {
    recordApiRequestSeconds((Date.now() - startedAtMs) / MS_PER_SECOND);
  }
};
