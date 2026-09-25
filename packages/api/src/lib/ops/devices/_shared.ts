import type { Selectable, Transaction } from 'kysely';

import type { DB } from '@zamfono/shared';

import { Conflict, OpError } from '../types.js';

/** A `devices` row as Kysely's `CamelCasePlugin` maps it (§11.2); never carries the raw password. */
export type DeviceRow = Selectable<DB['devices']>;

const STATUS_NOT_FOUND = 404;
const STATUS_FORBIDDEN = 403;
export const STATUS_UNPROCESSABLE_ENTITY = 422;

export const TRANSPORTS = ['tls', 'plain'] as const;
export type Transport = (typeof TRANSPORTS)[number];
export const DEVICE_KINDS = ['manual', 'ringotel'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Throws 409 while `userId` already has a live `ringotel` device (`devices_one_ringotel_per_user`). */
export async function assertNoExistingRingotelDevice(
  db: Transaction<DB>,
  userId: string
): Promise<void> {
  const existing = await db
    .selectFrom('devices')
    .select(['id', 'label'])
    .where('userId', '=', userId)
    .where('kind', '=', 'ringotel')
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (existing) {
    throw new Conflict('users: already has a ringotel device', [
      { kind: 'device', id: existing.id, label: existing.label }
    ]);
  }
}

export type DeviceOut = {
  id: string;
  userId: string;
  label: string;
  kind: DeviceKind;
  transport: Transport;
  allowedIps: string[] | null;
  sipUsername: string;
  lastRegisteredAt: string | null;
  createdAt: string;
};

/** The wire shape of a device, never its encrypted password (§5.2 "SIP credentials"). */
export function toDeviceOut(row: DeviceRow): DeviceOut {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    kind: row.kind as DeviceKind,
    transport: row.transport as Transport,
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
  const row = await db
    .selectFrom('devices')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw new OpError(STATUS_NOT_FOUND, `device '${id}' not found`);
  }
  return row;
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
      STATUS_FORBIDDEN,
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
  transport: Transport
): void {
  if (actorRole !== 'user') {
    return;
  }
  if (userId !== actorId || transport !== 'tls') {
    throw new OpError(
      STATUS_FORBIDDEN,
      'devices: may create only your own tls device'
    );
  }
}
