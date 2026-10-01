import process from 'node:process';
import type { Handle, RequestEvent, ServerInit } from '@sveltejs/kit';
import pino from 'pino';

import { MS_PER_SECOND } from '@zamfono/shared';

import { addressKey } from '$lib/server/addressKey.js';
import { crossSiteFormRejection } from '$lib/server/auth/crossSiteForms.js';
import {
  isRole,
  requiredJwtSecret,
  verifyAccessToken
} from '$lib/server/auth/jwt.js';
import { createCoreClient, fetchCoreVersion } from '$lib/server/coreClient.js';
import { getDb } from '$lib/server/db.js';
import { startBackgroundJobs } from '$lib/server/jobs/background.js';
import { Limiter, type LimitKind } from '$lib/server/limiter.js';
import { recordApiRequestSeconds } from '$lib/server/metrics.js';
import { onPropagate } from '$lib/server/ops/runner.js';
import { setCoreVersionLookup } from '$lib/server/ops/system/info.js';
import {
  coreTrunkStatusLookup,
  setTrunkStatusLookup
} from '$lib/server/ops/trunks/index.js';
import type { Actor } from '$lib/server/ops/types.js';
import { problem } from '$lib/server/problem.js';
import { propagateConfig } from '$lib/server/propagation.js';
import { keyringFromEnv, type Keyring } from '$lib/server/secretbox.js';

const BEARER_PREFIX = 'Bearer ';
const UNAUTHORIZED_STATUS = 401;
const NOT_FOUND_STATUS = 404;
const TOO_MANY_REQUESTS_STATUS = 429;
const API_PREFIX = '/api/v1';
const INTERNAL_PREFIX = '/internal';
const jobsLogger = pino({ name: 'hooks' });

/**
 * Every background job is started from `init` below: this file is part of the SvelteKit build
 * that also builds `runOperation` and every route, so a job started here shares their module
 * instance of every import, and an operation reaches it by a call — `server.ts` is a separate
 * esbuild bundle with its own copy of every relative import. Outside a stack (`vite dev`), a
 * missing `DB_FILE` or `SECRETBOX_KEY` disables the jobs that need it, never the module.
 */
/** `getDb()`, or `null` with a boot-time log line for a missing `DB_FILE`. */
function tryGetDb(): ReturnType<typeof getDb> | null {
  try {
    return getDb();
  } catch (error) {
    jobsLogger.error(
      { error },
      'boot: DB_FILE missing, config propagation and the background jobs disabled'
    );
    return null;
  }
}

/** The `.env` keyring, or `null` with a boot-time log line for a missing `SECRETBOX_KEY`. */
function tryKeyring(): Keyring | null {
  try {
    return keyringFromEnv(process.env);
  } catch (error) {
    jobsLogger.error(
      { error },
      'boot: SECRETBOX_KEY missing, the background jobs disabled'
    );
    return null;
  }
}

/**
 * Wires the operations to `core` and starts the background jobs
 * (`lib/server/jobs/background.ts`). SvelteKit runs it once, and serves no request before it
 * resolves; a failure of the first-boot seed rejects it, which fails loading the handler and so
 * `api`'s boot. The jobs stop on `sveltekit:shutdown`, which `server.ts` emits on SIGTERM and
 * SIGINT.
 */
export const init: ServerInit = async () => {
  // §9.4 "Provisioning and status": trunk status is the core's live state, read per request.
  setTrunkStatusLookup(coreTrunkStatusLookup(createCoreClient()));
  // §7 "Version": `system.info` asks `core` what it runs, per request.
  setCoreVersionLookup(() => fetchCoreVersion());
  const db = tryGetDb();
  if (!db) {
    return;
  }
  onPropagate(change => propagateConfig(db, change.kind));
  const kr = tryKeyring();
  if (!kr) {
    return;
  }
  const jobs = await startBackgroundJobs(db, kr, jobsLogger);
  process.once('sveltekit:shutdown', () => {
    jobs.stop();
  });
};

type AuthResult = { actor: Actor | null; clientId: string | null };

const ANONYMOUS: AuthResult = { actor: null, clientId: null };

// One limiter for the process's lifetime (§5.5): counters reset on an `api` restart.
const limiter = new Limiter();

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
  return problem(TOO_MANY_REQUESTS_STATUS, 'too many requests', undefined, {
    'retry-after': String(result.retryAfterS)
  });
}

/**
 * The bearer token's `Actor` and OAuth client id, or both `null` for a missing token, a bad
 * signature, or a deleted account (§5.2, §5.3, §5.9); the role is read fresh from `users` so a
 * role change takes effect before the token's own 15-minute expiry.
 */
async function resolveActor(request: Request): Promise<AuthResult> {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith(BEARER_PREFIX)) {
    return ANONYMOUS;
  }
  const nowS = Math.floor(Date.now() / MS_PER_SECOND);
  const claims = verifyAccessToken(
    requiredJwtSecret(),
    header.slice(BEARER_PREFIX.length),
    nowS
  );
  if (!claims) {
    return ANONYMOUS;
  }
  const user = await getDb()
    .selectFrom('users')
    .select(['id', 'name', 'role', 'deletedAt'])
    .where('id', '=', claims.sub)
    .executeTakeFirst();
  if (user?.deletedAt !== null) {
    return ANONYMOUS;
  }
  const role = isRole(user.role) ? user.role : claims.role;
  return {
    actor: { id: user.id, name: user.name, role },
    clientId: claims.cid
  };
}

/**
 * Refuses a cross-site form submission to a browser-served page (`crossSiteFormRejection`);
 * resolves `/api/v1/*`'s bearer token into `event.locals.actor`, 401 problem+json without one;
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
    return new Response(null, { status: NOT_FOUND_STATUS });
  }
  const limited = rateLimitResponse(pathname, event);
  if (limited) {
    return limited;
  }
  if (!pathname.startsWith(API_PREFIX)) {
    event.locals.actor = null;
    event.locals.clientId = null;
    return resolve(event);
  }
  // `/api/v1/openapi.json` is inside this prefix and so requires a bearer token like every other
  // `/api/v1/*` endpoint; §10.3 lists no separate row for it, so it gets no separate exemption.
  const { actor, clientId } = await resolveActor(event.request);
  if (!actor) {
    return problem(UNAUTHORIZED_STATUS, 'unauthorized');
  }
  // eslint-disable-next-line require-atomic-updates -- `event` is this call's own local object, never mutated concurrently
  event.locals.actor = actor;
  // eslint-disable-next-line require-atomic-updates -- `event` is this call's own local object, never mutated concurrently
  event.locals.clientId = clientId;
  return resolve(event);
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
