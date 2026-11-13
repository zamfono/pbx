import type { RequestEvent } from '@sveltejs/kit';
import * as env from '$app/env/private';

import {
  HEALTH_CONTENT_TYPE,
  healthHttpStatus,
  isValidBearer,
  type HealthDocument
} from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';
import { currentHealth } from '#lib/server/health.js';

/** Whether the request carries `METRICS_TOKEN` as its bearer token; never without one configured. */
function showsChecks(event: RequestEvent): boolean {
  const token = env.METRICS_TOKEN;
  return (
    token !== undefined &&
    isValidBearer(event.request.headers.get('authorization'), token)
  );
}

/**
 * `GET /healthz` (§6.3 "Health", §10.3 "Health"): public and unauthenticated, so the external
 * uptime check (§7) can reach it through the proxy. Its checks tell which protection or job is
 * down, so only the bearer of `METRICS_TOKEN` gets them; anyone else, a wrong token included, the
 * overall `status` alone, computed from all of them, and never 401, so an uptime check keeps
 * working. Admins read the checks with `system.health`.
 */
export async function GET(event: RequestEvent): Promise<Response> {
  const document = await currentHealth(getDb);
  const body: HealthDocument | Pick<HealthDocument, 'status'> = showsChecks(
    event
  )
    ? document
    : { status: document.status };
  return new Response(JSON.stringify(body), {
    status: healthHttpStatus(document),
    headers: {
      'content-type': HEALTH_CONTENT_TYPE,
      'cache-control': 'no-store'
    }
  });
}
