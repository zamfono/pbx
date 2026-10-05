import * as env from '$app/env/private';

import { HTTP_OK, HTTP_SERVICE_UNAVAILABLE } from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';
import { apiReady } from '#lib/server/health.js';

/**
 * `GET /readyz` (§6.3 "Health"), the compose healthcheck's: 200 with an empty body while the
 * database is open with no migration pending, else 503. Internal: Caddy answers 404 for it, and
 * the hook refuses it when it carries `X-Forwarded-For`.
 */
export async function GET(): Promise<Response> {
  const ready = await apiReady(getDb(), env.MIGRATIONS_DIR);
  return new Response(null, {
    status: ready ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE
  });
}
