import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import {
  allowedIpsColumn,
  allowedIpsSchema,
  DEVICE_KINDS,
  DEVICE_TRANSPORTS,
  type DB
} from '@zamfono/shared';

import { assertNoLiveHolder } from '../liveHolder.js';
import { liveRow } from '../rows.js';
import type { Context } from '../types.js';

/** A `devices` row as Kysely's `CamelCasePlugin` maps it (§11.2); never carries the raw password. */
export type DeviceRow = Selectable<DB['devices']>;

/** One `device_blf_keys` row, as an audit diff records the keys a removed extension drops. */
export type DroppedBlfKey = { deviceId: string; ext: string; position: number };

/** Throws 409 while `userId` already has a live `ringotel` device (`devices_one_ringotel_per_user`). */
export async function assertNoExistingRingotelDevice(
  db: Transaction<DB>,
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
export function toDeviceOut(row: DeviceRow): DeviceOut {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    kind: row.kind,
    transport: row.transport,
    allowedIps: allowedIpsColumn.nullable().decode(row.allowedIpsJson),
    sipUsername: row.sipUsername,
    lastRegisteredAt: row.lastRegisteredAt,
    createdAt: row.createdAt
  };
}

/** Loads a live device by id, or throws `OpError(404)`. */
export async function liveDevice(
  db: Transaction<DB>,
  id: string
): Promise<DeviceRow> {
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
    .select(['deviceId', 'ext', 'position'])
    .where('ext', '=', ext)
    .execute();
}
