import * as env from '$app/env/private';

import { fetchCoreHealth } from '#lib/server/coreClient.js';
import { getDb } from '#lib/server/db.js';
import {
  apiHealth,
  countKeyRotationRemaining,
  healthStatus,
  type CoreReachability
} from '#lib/server/health.js';
import { certSyncStatus } from '#lib/server/jobs/certSync.js';
import { keyringFromEnv, type Keyring } from '#lib/server/secretbox.js';

const keyringCache: { resolved: boolean; keyring: Keyring | null } = {
  resolved: false,
  keyring: null
};

/**
 * The keyring, resolved once per process and cached like `getDb()`. `SECRETBOX_KEY` absent or
 * malformed (§5.4) must not turn the public, unauthenticated `/healthz` (§10.3 Health row) into
 * a 500: `keyRotationRemaining` is reported only while a keyring is available, and
 * `healthStatus` never depends on it.
 */
function resolveKeyring(): Keyring | null {
  if (!keyringCache.resolved) {
    try {
      keyringCache.keyring = keyringFromEnv(env);
    } catch {
      keyringCache.keyring = null;
    }
    keyringCache.resolved = true;
  }
  return keyringCache.keyring;
}

/**
 * `core`'s own `/healthz` (Task 19, `CoreHealth`), reached over the internal Docker network
 * (§6.3): `reachable` reports whether a response was received and parsed at all, and `ari`
 * comes from that body, since core's own HTTP status folds its database and ARI checks
 * together (§6.3 "Health") and this pair keeps the two visible separately here.
 */
async function checkCore(): Promise<CoreReachability> {
  try {
    const body = await fetchCoreHealth();
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
  const db = getDb();
  const keyring = resolveKeyring();
  const health = await apiHealth({
    db,
    checkCore,
    keyRotationRemaining: keyring
      ? await countKeyRotationRemaining(db, keyring)
      : 0,
    certificateSync: certSyncStatus()
  });
  return Response.json(health, { status: healthStatus(health) });
}
