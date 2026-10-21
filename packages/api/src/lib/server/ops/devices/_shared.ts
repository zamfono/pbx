import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  allowedIpsColumn,
  allowedIpsSchema,
  DEVICE_KINDS,
  DEVICE_TRANSPORTS,
  type DB,
  type Db
} from '@zamfono/shared';

import { assertNoLiveHolder } from '../liveHolder.js';
import { liveRow } from '../rows.js';
import type { Context } from '../types.js';
import {
  loadMwiRingGroups,
  mwiRingGroupsSchema,
  type MwiRingGroups
} from './_mwiRingGroups.js';

/** A `devices` row as Kysely's `CamelCasePlugin` maps it (§11.2); never carries the raw password. */
export type DeviceRow = Selectable<DB['devices']>;

/**
 * One `device_blf_keys` row, as an audit diff records the keys a removed extension drops: a BLF
 * key (`ext`), or a `yealink` device's mailbox key (`mailboxExt`, `label`), which entries recorded
 * before mailbox keys never hold.
 */
export type DroppedBlfKey = {
  deviceId: string;
  position: number;
  ext?: string | null;
  mailboxExt?: string | null;
  label?: string | null;
};

/** Throws 409 while `userId` already has a live `ringotel` device (`devices_one_ringotel_per_user`). */
export async function assertNoExistingRingotelDevice(
  db: Db,
  userId: string
): Promise<void> {
  await assertNoLiveHolder(db, 'users: already has a ringotel device', {
    table: 'devices',
    kind: 'device',
    label: 'label',
    values: { userId, kind: 'ringotel' }
  });
}

/** A device's wire shape (§10.3), as `toDeviceOut` assembles it. */
export const deviceOut = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string(),
  kind: z.enum(DEVICE_KINDS),
  transport: z.enum(DEVICE_TRANSPORTS),
  allowedIps: allowedIpsSchema.nullable(),
  sipUsername: z.string(),
  ringtone: z
    .string()
    .nullable()
    .describe(
      "A yealink device's built-in ringtone, written into its provisioning link's file; null: the phone's own."
    ),
  mwiRingGroups: mwiRingGroupsSchema,
  provisionedAt: z
    .string()
    .nullable()
    .describe(
      "When the phone last fetched its provisioning link's file, ISO 8601."
    ),
  provisionedFrom: z
    .string()
    .nullable()
    .describe('The client address of that fetch.'),
  // Not its latest REGISTER refresh; whether it is registered now is live state (§10.1).
  lastRegisteredAt: z
    .string()
    .nullable()
    .describe('When the device last became reachable, ISO 8601.'),
  createdAt: z.string()
});
export type DeviceOut = z.infer<typeof deviceOut>;

/** The SIP credentials `devices.rotate` and a `ringotel` device's reveal answer with (§5.2). */
export const sipCredentialsOut = z.object({
  sipUsername: z.string(),
  sipPassword: z.string()
});

/** The wire shape of a device, never its encrypted password (§5.2 "SIP credentials"). */
function toDeviceOut(row: DeviceRow, mwiRingGroups: MwiRingGroups): DeviceOut {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    kind: row.kind,
    transport: row.transport,
    allowedIps: allowedIpsColumn.nullable().decode(row.allowedIpsJson),
    sipUsername: row.sipUsername,
    ringtone: row.ringtone,
    mwiRingGroups,
    provisionedAt: row.provisionedAt,
    provisionedFrom: row.provisionedFrom,
    lastRegisteredAt: row.lastRegisteredAt,
    createdAt: row.createdAt
  };
}

/** The wire shape of each of `rows`, in order (§10.3). */
export async function toDevicesOut(
  db: Db,
  rows: DeviceRow[]
): Promise<DeviceOut[]> {
  const groups = await loadMwiRingGroups(db, rows);
  return rows.map(row => toDeviceOut(row, groups.get(row.id) ?? null));
}

/** The wire shape of one device (§10.3). */
export async function deviceOutOf(db: Db, row: DeviceRow): Promise<DeviceOut> {
  const groups = await loadMwiRingGroups(db, [row]);
  return toDeviceOut(row, groups.get(row.id) ?? null);
}

/** Loads a live device by id, or throws `OpError(404)`. */
export async function liveDevice(db: Db, id: string): Promise<DeviceRow> {
  return liveRow(db, 'devices', id, `device '${id}' not found`);
}

/** The `scope` of an operation on device `id`: the caller's own `tls` device alone (§10.3 "Devices"). */
export async function ownTlsDevice(
  ctx: Context,
  input: { id: string }
): Promise<boolean> {
  const device = await liveDevice(ctx.db, input.id);
  return device.userId === ctx.actor.id && device.transport === 'tls';
}

/**
 * The `device_blf_keys` rows the FK cascade drops when extension `ext` is removed, captured before
 * the delete so the audit diff can record them (§5.9, §11.2 "extensions").
 */
export async function loadDroppedBlfKeys(
  ctx: Context,
  ext: string
): Promise<DroppedBlfKey[]> {
  return ctx.db
    .selectFrom('deviceBlfKeys')
    .select(['deviceId', 'position', 'ext', 'mailboxExt', 'label'])
    .where(eb => eb.or([eb('ext', '=', ext), eb('mailboxExt', '=', ext)]))
    .execute();
}
