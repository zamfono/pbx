import * as env from '$app/env/private';

import {
  HEALTH_CONTENT_TYPE,
  healthHttpStatus,
  type HealthChecks
} from '@zamfono/shared';

import { skippedConfigRows } from '#lib/server/configRenderSkips.js';
import { getCoreClient } from '#lib/server/coreClient.js';
import { getDb } from '#lib/server/db.js';
import { apiHealth } from '#lib/server/health.js';
import { certSyncLastPass, certSyncStatus } from '#lib/server/jobs/certSync.js';
import { relayState } from '#lib/server/mail/relayState.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';
import { sipBanHelperState } from '#lib/server/sipBanList.js';

/** `core`'s own checks from its `/healthz`, whatever its status; `null` while it does not answer. */
async function coreChecks(): Promise<HealthChecks | null> {
  try {
    return (await getCoreClient().health()).checks;
  } catch {
    return null;
  }
}

/**
 * `GET /healthz` (§6.3 "Health", §10.3 "Health"): public and unauthenticated, so the external
 * uptime check (§7) can reach it through the proxy.
 */
export async function GET(): Promise<Response> {
  const document = await apiHealth({
    db: getDb,
    migrationsDir: env.MIGRATIONS_DIR,
    coreChecks,
    keyring: keyringFromEnv(env),
    certificateSync: { state: certSyncStatus(), at: certSyncLastPass() },
    sipBanHelper: await sipBanHelperState(),
    mailRelay: relayState(),
    skippedConfigRows: skippedConfigRows().length
  });
  return new Response(JSON.stringify(document), {
    status: healthHttpStatus(document),
    headers: {
      'content-type': HEALTH_CONTENT_TYPE,
      'cache-control': 'no-store'
    }
  });
}
