import { timingSafeEqual } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

import { resolveVersion } from '@zamfono/shared';

import { createCoreClient, fetchCoreHealth } from '$lib/server/coreClient.js';
import { getDb } from '$lib/server/db.js';
import { certSyncStatus } from '$lib/server/jobs/certSync.js';
import { renderMetrics } from '$lib/server/metrics.js';

const STATUS_NOT_FOUND = 404;
const STATUS_UNAUTHORIZED = 401;
const STATUS_OK = 200;
const BEARER_PREFIX = 'Bearer ';
const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4';

/** `core`'s own ARI connection state (§7), read the same way `/healthz` reads it. */
async function checkAri(): Promise<boolean> {
  const body = await fetchCoreHealth();
  return body.ari;
}

/** Whether `authorization` is exactly `Bearer <token>`, compared in constant time (§7 `METRICS_TOKEN`: a static shared secret, so a byte-by-byte comparison would leak it through timing). */
function isValidBearer(authorization: string | null, token: string): boolean {
  const expected = Buffer.from(`${BEARER_PREFIX}${token}`);
  const actual = Buffer.from(authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * `GET /metrics` (§7 "Metrics"): 404 while `METRICS_TOKEN` is unset, so an unconfigured stack
 * exposes nothing even if a request reaches `api` directly instead of through Caddy; 401 on a
 * missing or wrong bearer token once one is configured.
 */
export async function GET(event: RequestEvent): Promise<Response> {
  const token = env.METRICS_TOKEN;
  if (!token) {
    return new Response(null, { status: STATUS_NOT_FOUND });
  }
  const authorization = event.request.headers.get('authorization');
  if (!isValidBearer(authorization, token)) {
    return new Response(null, { status: STATUS_UNAUTHORIZED });
  }
  const coreClient = createCoreClient();
  const body = await renderMetrics({
    db: getDb(),
    dbFile: env.DB_FILE ?? '',
    checkAri,
    coreState: () => coreClient.state(),
    certSyncStatus,
    version: resolveVersion(env)
  });
  return new Response(body, {
    status: STATUS_OK,
    headers: { 'content-type': PROMETHEUS_CONTENT_TYPE }
  });
}
