import process from 'node:process';

import type { CoreHealth } from '@zamfono/shared';

import { getDb } from '../../lib/db.js';
import {
  apiHealth,
  countKeyRotationRemaining,
  healthStatus,
  type CoreReachability
} from '../../lib/health.js';
import {
  getCertSyncScheduler,
  type CertSyncStatus
} from '../../lib/jobs/certSync.js';
import { keyringFromEnv, type Keyring } from '../../lib/secretbox.js';

const CORE_HEALTH_TIMEOUT_MS = 3000;
const DEFAULT_CORE_INTERNAL_URL = 'http://core:3000';

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
      keyringCache.keyring = keyringFromEnv(process.env);
    } catch {
      keyringCache.keyring = null;
    }
    keyringCache.resolved = true;
  }
  return keyringCache.keyring;
}

/**
 * The certificate-sync scheduler's status (§6.4), read the same instance `server.ts` started.
 * `ORIGIN` absent or malformed must not turn the public `/healthz` into a 500, so a scheduler
 * that fails to construct reports `'unknown'`, the same as one that has not polled yet.
 */
function resolveCertificateSync(): CertSyncStatus {
  try {
    return getCertSyncScheduler().status();
  } catch {
    return 'unknown';
  }
}

/**
 * `core`'s own `/healthz` (Task 19, `CoreHealth`), reached over the internal Docker network
 * (§6.3): `reachable` reports whether a response was received and parsed at all, and `ari`
 * comes from that body, since core's own HTTP status folds its database and ARI checks
 * together (§6.3 "Health") and this pair keeps the two visible separately here.
 */
async function checkCore(): Promise<CoreReachability> {
  const baseUrl = process.env.CORE_INTERNAL_URL ?? DEFAULT_CORE_INTERNAL_URL;
  try {
    const response = await fetch(`${baseUrl}/healthz`, {
      signal: AbortSignal.timeout(CORE_HEALTH_TIMEOUT_MS)
    });
    const body = (await response.json()) as CoreHealth;
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
    certificateSync: resolveCertificateSync()
  });
  return Response.json(health, { status: healthStatus(health) });
}
