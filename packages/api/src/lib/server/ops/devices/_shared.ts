import type { Selectable, Transaction } from 'kysely';

import {
  type DB,
  type DeviceKind,
  type DeviceTransport
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

export type DeviceOut = {
  id: string;
  userId: string;
  label: string;
  kind: DeviceKind;
  transport: DeviceTransport;
  allowedIps: string[] | null;
  sipUsername: string;
  /** When the device last became reachable (§11 `devices.last_registered_at`), not its latest
   * REGISTER refresh; whether it is registered now is live state (§10.1). */
  lastRegisteredAt: string | null;
  createdAt: string;
};

/** The wire shape of a device, never its encrypted password (§5.2 "SIP credentials"). */
export function toDeviceOut(row: DeviceRow): DeviceOut {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    kind: row.kind,
    transport: row.transport,
    allowedIps: row.allowedIpsJson
      ? (JSON.parse(row.allowedIpsJson) as string[])
      : null,
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
