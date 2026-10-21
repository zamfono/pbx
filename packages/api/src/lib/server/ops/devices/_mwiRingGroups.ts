import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT, type Db } from '@zamfono/shared';

import { ringGroupMemberships } from '#lib/server/ringGroupMembership.js';

import { OpError, type Context } from '../types.js';

/** The ring-group mailboxes a device's message indicator counts besides its user's own (§9.3 "MWI"). */
export const mwiRingGroupsSchema = z
  .array(z.string())
  .nullable()
  .describe(
    "The ring groups whose mailboxes the device's message indicator counts besides the user's own: null for every group the user belongs to, [] for the user's own mailbox alone."
  );
export type MwiRingGroups = z.infer<typeof mwiRingGroupsSchema>;

/** Throws 422 for an id in `groups` that is no ring group `userId` belongs to. */
async function assertOwnRingGroups(
  db: Db,
  userId: string,
  groups: string[]
): Promise<void> {
  const own = new Set(
    (await ringGroupMemberships(db, { userId })).map(
      membership => membership.ringGroupId
    )
  );
  for (const id of groups) {
    if (!own.has(id)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `devices: ring group '${id}' is not one of this device's user's`
      );
    }
  }
}

/**
 * Stores `groups` as device `deviceId`'s message-indicator ring groups (§11.2): `null` sets
 * `mwi_all_ring_groups`, a list clears it and becomes the `device_mwi_ring_groups` rows.
 */
export async function writeMwiRingGroups(
  ctx: Context,
  device: { id: string; userId: string },
  groups: MwiRingGroups
): Promise<void> {
  if (groups !== null) {
    await assertOwnRingGroups(ctx.db, device.userId, groups);
  }
  await ctx.db
    .updateTable('devices')
    .set({ mwiAllRingGroups: groups === null ? 1 : 0 })
    .where('id', '=', device.id)
    .execute();
  await ctx.db
    .deleteFrom('deviceMwiRingGroups')
    .where('deviceId', '=', device.id)
    .execute();
  const unique = [...new Set(groups ?? [])];
  if (unique.length > 0) {
    await ctx.db
      .insertInto('deviceMwiRingGroups')
      .values(unique.map(ringGroupId => ({ deviceId: device.id, ringGroupId })))
      .execute();
  }
}

/** Each of `devices`' message-indicator ring groups, sorted; `null` for every group. */
export async function loadMwiRingGroups(
  db: Db,
  devices: { id: string; mwiAllRingGroups: number }[]
): Promise<Map<string, MwiRingGroups>> {
  const picked = devices.filter(device => device.mwiAllRingGroups === 0);
  const rows =
    picked.length > 0
      ? await db
          .selectFrom('deviceMwiRingGroups')
          .select(['deviceId', 'ringGroupId'])
          .where(
            'deviceId',
            'in',
            picked.map(device => device.id)
          )
          .orderBy('ringGroupId')
          .execute()
      : [];
  return new Map(
    devices.map(device => [
      device.id,
      device.mwiAllRingGroups === 1
        ? null
        : rows
            .filter(row => row.deviceId === device.id)
            .map(row => row.ringGroupId)
    ])
  );
}
