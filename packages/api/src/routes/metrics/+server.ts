import { timingSafeEqual } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import {
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
  resolveVersion
} from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import { getDb } from '#lib/server/db.js';
import { certSyncStatus } from '#lib/server/jobs/certSync.js';
import { renderMetrics } from '#lib/server/metrics.js';

const BEARER_PREFIX = 'Bearer ';
const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4';

/** `core`'s own ARI connection state (§7), read the same way `/healthz` reads it. */
async function checkAri(): Promise<boolean> {
  const body = await getCoreClient().health();
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
  if (token === undefined) {
    return new Response(null, { status: HTTP_NOT_FOUND });
  }
  const authorization = event.request.headers.get('authorization');
  if (!isValidBearer(authorization, token)) {
    return new Response(null, { status: HTTP_UNAUTHORIZED });
  }
  const body = await renderMetrics({
    db: getDb(),
    dbFile: env.DB_FILE,
    checkAri,
    coreState: async () => getCoreClient().state(),
    certSyncStatus,
    version: resolveVersion(env)
  });
  return new Response(body, {
    status: HTTP_OK,
    headers: { 'content-type': PROMETHEUS_CONTENT_TYPE }
  });
}
