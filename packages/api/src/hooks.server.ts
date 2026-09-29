import process from 'node:process';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import pino from 'pino';

import { addressKey } from './lib/addressKey.js';
import { crossSiteFormRejection } from './lib/auth/crossSiteForms.js';
import { isRole, verifyAccessToken } from './lib/auth/jwt.js';
import { createCoreClient, fetchCoreVersion } from './lib/coreClient.js';
import { getDb } from './lib/db.js';
import { getCertSyncScheduler } from './lib/jobs/certSync.js';
import { reencryptSweep } from './lib/jobs/keyRotation.js';
import { Limiter, type LimitKind } from './lib/limiter.js';
import { recordApiRequestSeconds } from './lib/metrics.js';
import { onPropagate } from './lib/ops/runner.js';
import { setCoreVersionLookup } from './lib/ops/system/info.js';
import {
  coreTrunkStatusLookup,
  setTrunkStatusLookup
} from './lib/ops/trunks/index.js';
import type { Actor } from './lib/ops/types.js';
import { problem } from './lib/problem.js';
import { propagateConfig } from './lib/propagation.js';
import { keyringFromEnv, type Keyring } from './lib/secretbox.js';

const BEARER_PREFIX = 'Bearer ';
const MS_PER_SECOND = 1000;
const UNAUTHORIZED_STATUS = 401;
const NOT_FOUND_STATUS = 404;
const TOO_MANY_REQUESTS_STATUS = 429;
const API_PREFIX = '/api/v1';
const INTERNAL_PREFIX = '/internal';
const jobsLogger = pino({ name: 'hooks' });

/**
 * Boot-time background jobs (§3.1 config propagation, §6.4 certificate sync, §5.4 key rotation),
 * wired from this module's own load: this file is part of the SvelteKit build that also builds
 * `runOperation` and every route, so a hook registered here shares their module instance of
 * `./lib/ops/runner.js` — `server.ts` is a separate esbuild bundle with its own copy of every
 * relative import. This file loads before the process serves a first request (§6.4 "The same
 * sync runs at `api` start"). Each piece degrades independently: a missing env var (`DB_FILE`,
 * `ORIGIN`, `SECRETBOX_KEY`) disables only that piece, never the module.
 */
/** `getDb()`, or `null` with a boot-time log line for a missing `DB_FILE`. */
function tryGetDb(): ReturnType<typeof getDb> | null {
  try {
    return getDb();
  } catch (error) {
    jobsLogger.error(
      { error },
      'boot: DB_FILE missing, config propagation and key rotation disabled'
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
      'boot: SECRETBOX_KEY missing, key-rotation sweep disabled'
    );
    return null;
  }
}

/**
 * Starts the boot jobs and resolves once the §5.4 key-rotation sweep has finished, which
 * `handle` waits on before it serves anything: a request answered mid-sweep could read a
 * secret the sweep is re-encrypting. A sweep that throws is logged and lets requests through,
 * since the failure is already reported by `/healthz`'s remaining count.
 */
async function startBackgroundJobs(): Promise<void> {
  // §9.4 "Provisioning and status": trunk status is the core's live state, read per request.
  setTrunkStatusLookup(coreTrunkStatusLookup(createCoreClient()));
  // §7 "Version": `system.info` asks `core` what it runs, per request.
  setCoreVersionLookup(() => fetchCoreVersion());
  try {
    getCertSyncScheduler();
  } catch (error) {
    jobsLogger.error(
      { error },
      'boot: certificate-sync scheduler failed to start'
    );
  }
  const db = tryGetDb();
  if (!db) {
    return;
  }
  onPropagate(change => propagateConfig(db, change.kind));
  const kr = tryKeyring();
  if (!kr) {
    return;
  }
  try {
    await reencryptSweep(db, kr, jobsLogger);
  } catch (error) {
    jobsLogger.error({ error }, 'boot: key-rotation sweep failed');
  }
}

const bootJobs = startBackgroundJobs();

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

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required.');
  }
  return secret;
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
    jwtSecret(),
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
 * Waits for the boot jobs (§5.4: the key-rotation sweep finishes before the first request is
 * served), then runs `handleRequest`, timing it for `zamfono_api_request_seconds` (§7 "API
 * latency") regardless of which branch it returns from or whether it throws. The wait falls
 * outside that timing, so a boot-time queue does not read as request latency.
 */
export const handle: Handle = async input => {
  await bootJobs;
  const startedAtMs = Date.now();
  try {
    return await handleRequest(input);
  } finally {
    recordApiRequestSeconds((Date.now() - startedAtMs) / MS_PER_SECOND);
  }
};
