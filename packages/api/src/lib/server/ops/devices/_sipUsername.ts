import type { Db } from '@zamfono/shared';

import { newSlug, sipUsername } from '#lib/server/sip.js';

import { liveHolder, type Collision } from '../liveHolder.js';

// §11.2 `devices_sip_username` (unique among live devices): a 5-character slug drawn from 36
// characters gives ~60M combinations per extension, so a handful of retries clears the rare
// collision instead of the insert failing with a raw driver error.
const MAX_USERNAME_ATTEMPTS = 5;

/**
 * The live row already naming the SIP endpoint `name`: a device (§11.2 `devices_sip_username`),
 * or an `inbound_auth` trunk, whose inbound endpoint is named by its username (§9.4 "Inbound
 * identification", `identify_by = auth_username`). `exclude` is the row being written.
 */
export async function endpointNameHolder(
  db: Db,
  name: string,
  exclude: { deviceId?: string; trunkId?: string } = {}
): Promise<Collision | null> {
  return (
    (await liveHolder(
      db,
      {
        table: 'devices',
        kind: 'device',
        label: 'label',
        values: { sipUsername: name }
      },
      exclude.deviceId
    )) ??
    (await liveHolder(
      db,
      {
        table: 'trunks',
        kind: 'trunk',
        label: 'name',
        values: { username: name, inboundAuth: 1 }
      },
      exclude.trunkId
    ))
  );
}

/**
 * A `sipUsername(ext, …)` naming no endpoint yet (a live device other than `excludeId`, or an
 * inbound-auth trunk), retrying past a slug collision. Shared by `devices.create` (no
 * `excludeId`) and `users.update`'s extension rename, which excludes the device being renamed.
 */
export async function uniqueSipUsername(
  db: Db,
  ext: string,
  excludeId?: string
): Promise<string> {
  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt += 1) {
    const candidate = sipUsername(ext, newSlug());
    // eslint-disable-next-line no-await-in-loop -- each retry must see the previous candidate's outcome
    const holder = await endpointNameHolder(db, candidate, {
      deviceId: excludeId
    });
    if (holder === null) {
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
  db: Db,
  ext: string,
  deviceId: string,
  preferred: string
): Promise<string> {
  return (await endpointNameHolder(db, preferred, { deviceId })) === null
    ? preferred
    : uniqueSipUsername(db, ext, deviceId);
}
