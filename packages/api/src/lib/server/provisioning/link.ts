import { nowIso, type Db } from '@zamfono/shared';

import { sha256Hex } from '../hash.js';
import { yealinkFile } from './yealink.js';

/**
 * The answer to `GET /provision/<token>/<file>` (§10.4 "Provisioning link"), `null` for a 404: a
 * `.cfg` file of a live `yealink` device's link gets its configuration, rendered from the data of
 * this moment; anything else, Yealink's `.boot` files included, gets none. An answered fetch
 * records its time and client `address` on the device instead of an audit entry.
 */
export async function provisioningFile(
  db: Db,
  token: string,
  file: string,
  address: string
): Promise<string | null> {
  if (!file.endsWith('.cfg')) {
    return null;
  }
  const device = await db
    .selectFrom('devices')
    .selectAll()
    .where('provisioningTokenHash', '=', sha256Hex(token))
    .where('kind', '=', 'yealink')
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (device === undefined) {
    return null;
  }
  const body = await yealinkFile(db, device);
  await db
    .updateTable('devices')
    .set({ provisionedAt: nowIso(), provisionedFrom: address })
    .where('id', '=', device.id)
    .execute();
  return body;
}
