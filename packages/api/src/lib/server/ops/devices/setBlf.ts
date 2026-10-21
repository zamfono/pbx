import { z } from 'zod';

import {
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  type Db
} from '@zamfono/shared';

import { deviceBlfKeys } from '#lib/server/provisioning/ringotelRoster.js';
import { ringGroupMemberships } from '#lib/server/ringGroupMembership.js';

import { recordChange } from '../audit.js';
import { defineOperation, OpError } from '../types.js';
import {
  deviceKey,
  keyColumns,
  keyExtensions,
  loadDeviceKeys,
  type DeviceKey
} from './_keys.js';
import { pushToRingotel } from './_ringotelPush.js';
import { liveDevice, ownTlsDevice } from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    keys: z
      .array(deviceKey)
      .describe(
        'The keys in order. Empty: on a ringotel device every user and group extension, on a yealink device no keys.'
      )
  })
  .strict();

/** Throws 422 for any `keys` entry that is not a live extension or parking slot (§11.2 `extensions`). */
async function assertLiveExtensions(db: Db, keys: DeviceKey[]): Promise<void> {
  const exts = keyExtensions(keys);
  if (exts.length === 0) {
    return;
  }
  const rows = await db
    .selectFrom('extensions')
    .select('ext')
    .where('ext', 'in', exts)
    .execute();
  const live = new Set(rows.map(row => row.ext));
  for (const key of exts) {
    if (!live.has(key)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `devices: '${key}' is not a live extension`
      );
    }
  }
}

/**
 * Throws 422 for a mailbox key whose extension is neither `userId`'s own nor a ring group's they
 * belong to: the mailboxes `*95` opens for them (§9.3).
 */
async function assertOwnMailboxes(
  db: Db,
  userId: string,
  keys: DeviceKey[]
): Promise<void> {
  const mailboxes = keys.flatMap(key =>
    key.kind === 'mailbox' ? [key.ext] : []
  );
  if (mailboxes.length === 0) {
    return;
  }
  const groupIds = (await ringGroupMemberships(db, { userId })).map(
    membership => membership.ringGroupId
  );
  const own = await db
    .selectFrom('extensions')
    .select('ext')
    .where(eb =>
      eb.or([
        eb('userId', '=', userId),
        ...(groupIds.length > 0 ? [eb('ringGroupId', 'in', groupIds)] : [])
      ])
    )
    .execute();
  const allowed = new Set(own.map(row => row.ext));
  for (const ext of mailboxes) {
    if (!allowed.has(ext)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `devices: '${ext}' is not a mailbox of this device's user`
      );
    }
  }
}

/**
 * `PUT /devices/{id}/blf` (§10.4, §11.2): replaces a device's key list as a whole: a `ringotel`
 * device's BLF panel, pushed to Ringotel, or a `yealink` device's line keys, which its phone reads
 * at its next fetch of the provisioning link.
 */
export const setBlf = defineOperation({
  name: 'devices.setBlf',
  description:
    "Replaces a device's key list as a whole: a ringotel device's BLF panel, or a yealink device's line keys.",
  input: inputSchema,
  output: z.object({ id: z.string(), keys: z.array(deviceKey) }),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownTlsDevice,
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const device = await liveDevice(ctx.db, input.id);
    if (device.kind === 'manual') {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'devices: a manual device has no key list; its phone is set up by hand'
      );
    }
    if (
      device.kind !== 'yealink' &&
      input.keys.some(key => key.kind !== 'blf')
    ) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'devices: quick-dial, feature, mailbox, line and empty keys apply only to yealink devices'
      );
    }
    if (input.keys.filter(key => key.kind === 'line').length > 1) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'devices: a key list holds at most one line key'
      );
    }
    await assertLiveExtensions(ctx.db, input.keys);
    await assertOwnMailboxes(ctx.db, device.userId, input.keys);
    const before = await loadDeviceKeys(ctx.db, input.id);
    await ctx.db
      .deleteFrom('deviceBlfKeys')
      .where('deviceId', '=', input.id)
      .execute();
    if (input.keys.length > 0) {
      await ctx.db
        .insertInto('deviceBlfKeys')
        .values(
          input.keys.map((key, position) => ({
            deviceId: input.id,
            position,
            ...keyColumns(key)
          }))
        )
        .execute();
    }
    // `audit.undo` replays `from` through this operation, as its `keys`, in one replace (§5.8).
    recordChange(ctx, {
      field: 'blfKeys',
      from: before,
      to: input.keys
    });
    if (device.kind !== 'ringotel') {
      return { id: input.id, keys: input.keys };
    }
    pushToRingotel(ctx, {
      trigger: 'devices.setBlf',
      deviceId: input.id,
      push: async (provider, stored, db) => {
        await provider.onDeviceBlfChanged?.(
          stored,
          await deviceBlfKeys(db, stored.id)
        );
        return null;
      },
      failure: {
        what: `device ${input.id}'s BLF panel is stored`,
        retry: 'setting the panel again retries it'
      }
    });
    return { id: input.id, keys: input.keys };
  }
});
