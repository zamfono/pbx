import type { Selectable, Transaction } from 'kysely';

import {
  HTTP_FORBIDDEN,
  type DB,
  type DeviceKind,
  type DeviceTransport
} from '@zamfono/shared';

import { assertNoLiveHolder } from '../liveHolder.js';
import { liveRow } from '../rows.js';
import { OpError, type Context } from '../types.js';

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

/** Throws 403 unless `ctx.actor` may act on `device`: its own `tls` device, or an admin (§10.3). */
export function assertDeviceScope(
  actorRole: string,
  actorId: string,
  device: DeviceRow
): void {
  if (actorRole !== 'user') {
    return;
  }
  if (device.userId !== actorId || device.transport !== 'tls') {
    throw new OpError(
      HTTP_FORBIDDEN,
      'devices: may act only on your own tls device'
    );
  }
}

/**
 * Throws 403 unless `actorRole`/`actorId` may create a device for `userId` on `transport`: a
 * `user` actor only their own `tls` device, an admin any (§10.3 Devices row).
 */
export function assertDeviceCreateScope(
  actorRole: string,
  actorId: string,
  userId: string,
  transport: DeviceTransport
): void {
  if (actorRole !== 'user') {
    return;
  }
  if (userId !== actorId || transport !== 'tls') {
    throw new OpError(
      HTTP_FORBIDDEN,
      'devices: may create only your own tls device'
    );
  }
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
