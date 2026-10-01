import process from 'node:process';

import { resolveTenantTimeZone } from '@zamfono/shared';

/**
 * The tenant clock as `api` resolves it (§11.4 `timezone`, §6.4 "All hours resolve in the
 * tenant's time zone"): `settings.timezone`, else this container's `TZ`, else UTC. The backup
 * schedule, the certificate reload timing and mail dates all read it, so they cannot disagree.
 */
export function tenantTimeZone(settingsTimezone: string | null): string {
  return resolveTenantTimeZone(settingsTimezone, process.env.TZ);
}
