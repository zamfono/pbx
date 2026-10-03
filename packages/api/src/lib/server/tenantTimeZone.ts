import * as env from '$app/env/private';

import { resolveTenantTimeZone, type Db } from '@zamfono/shared';

/**
 * The tenant clock as `api` resolves it (§11.4 `timezone`, §6.4 "All hours resolve in the
 * tenant's time zone"): `settings.timezone`, else this container's `TZ`, else UTC. The backup
 * schedule, the certificate reload timing and mail dates all read it, so they cannot disagree.
 */
export function tenantTimeZone(settingsTimezone: string | null): string {
  return resolveTenantTimeZone(settingsTimezone, env.TZ);
}

/** `tenantTimeZone` of the stored `settings.timezone`, for a reader that needs only the zone. */
export async function readTenantTimeZone(db: Db): Promise<string> {
  const row = await db
    .selectFrom('settings')
    .select('timezone')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return tenantTimeZone(row.timezone);
}
