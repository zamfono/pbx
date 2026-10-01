import type { Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

import { newSlug, sipUsername } from '#lib/sip.js';

// §11.2 `devices_sip_username` (unique among live devices): a 5-character slug drawn from 36
// characters gives ~60M combinations per extension, so a handful of retries clears the rare
// collision instead of the insert failing with a raw driver error.
const MAX_USERNAME_ATTEMPTS = 5;

/**
 * Whether `candidate` already names a SIP endpoint other than device `excludeId`'s: a live device
 * (§11.2 `devices_sip_username`), or a live `inbound_auth` trunk, whose inbound endpoint is named
 * by its username (§9.4 "Inbound identification", `identify_by = auth_username`). The trunk side
 * refuses a username a device holds (`trunks/_writeChecks.ts`); this is the reverse guard.
 */
async function endpointNameTaken(
  db: Transaction<DB>,
  candidate: string,
  excludeId?: string
): Promise<boolean> {
  let devices = db
    .selectFrom('devices')
    .select('id')
    .where('sipUsername', '=', candidate)
    .where('deletedAt', 'is', null);
  if (excludeId !== undefined) {
    devices = devices.where('id', '!=', excludeId);
  }
  const trunk = await db
    .selectFrom('trunks')
    .select('id')
    .where('username', '=', candidate)
    .where('inboundAuth', '=', 1)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  return (
    trunk !== undefined || (await devices.executeTakeFirst()) !== undefined
  );
}

/**
 * A `sipUsername(ext, …)` naming no endpoint yet (a live device other than `excludeId`, or an
 * inbound-auth trunk), retrying past a slug collision. Shared by `devices.create` (no
 * `excludeId`) and `users.update`'s extension rename, which excludes the device being renamed.
 */
export async function uniqueSipUsername(
  db: Transaction<DB>,
  ext: string,
  excludeId?: string
): Promise<string> {
  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt += 1) {
    const candidate = sipUsername(ext, newSlug());
    // eslint-disable-next-line no-await-in-loop -- each retry must see the previous candidate's outcome
    if (!(await endpointNameTaken(db, candidate, excludeId))) {
      return candidate;
    }
  }
  throw new Error('devices: could not generate a unique sip username');
}

/**
 * `preferred` unless another live device or an inbound-auth trunk already holds it, in which
 * case a fresh `sipUsername` for `ext` (§11.2 `devices_sip_username` is unique tenant-wide): a
 * rename keeps the device's own slug unless doing so would collide with another endpoint.
 */
export async function sipUsernameOrFresh(
  db: Transaction<DB>,
  ext: string,
  deviceId: string,
  preferred: string
): Promise<string> {
  return (await endpointNameTaken(db, preferred, deviceId))
    ? uniqueSipUsername(db, ext, deviceId)
    : preferred;
}
