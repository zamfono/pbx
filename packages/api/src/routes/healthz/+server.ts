import * as env from '$app/env/private';

import { getCoreClient } from '#lib/server/coreClient.js';
import { getDb } from '#lib/server/db.js';
import {
  apiHealth,
  healthStatus,
  type CoreReachability
} from '#lib/server/health.js';
import { certSyncStatus } from '#lib/server/jobs/certSync.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

/**
 * `core`'s own `/healthz` (`CoreHealth`), reached over the internal Docker network
 * (§6.3): `reachable` reports whether a response was received and parsed at all, and `ari`
 * comes from that body, since core's own HTTP status folds its database and ARI checks
 * together (§6.3 "Health") and this pair keeps the two visible separately here.
 */
async function checkCore(): Promise<CoreReachability> {
  try {
    const body = await getCoreClient().health();
    return { reachable: true, ari: body.ari };
  } catch {
    return { reachable: false, ari: false };
  }
}

/**
 * `GET /healthz` (§6.3 "Health", §10.3 Health row): public and unauthenticated, so the
 * external uptime check (§7) can reach it through the proxy.
 */
export async function GET(): Promise<Response> {
  const health = await apiHealth({
    db: getDb(),
    checkCore,
    keyring: keyringFromEnv(env),
    certificateSync: certSyncStatus()
  });
  return Response.json(health, { status: healthStatus(health) });
}
