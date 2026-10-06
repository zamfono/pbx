import type { Db } from '@zamfono/shared';

import { loadSettings } from '../ops/settings/_shared.js';
import type { RingotelClient } from './ringotelClient.js';
import type { DeviceRow } from './types.js';

/** The extension a live `users` row holds, or `null` when it has none (§11.2 `extensions`). */
export async function extensionOfUser(
  db: Db,
  userId: string
): Promise<string | null> {
  const row = await db
    .selectFrom('extensions')
    .select('ext')
    .where('userId', '=', userId)
    .executeTakeFirst();
  return row?.ext ?? null;
}

/** A user's e-mail as Ringotel takes it: `''`, its own value for none, for a user without one
 *  (§11.2), so it mails no provisioning instructions. */
export function ringotelEmail(email: string | null): string {
  return email ?? '';
}

export async function userProfile(
  db: Db,
  userId: string
): Promise<{ name: string; email: string; ext: string }> {
  const user = await db
    .selectFrom('users')
    .select(['name', 'email'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  const ext = await extensionOfUser(db, userId);
  if (ext === null) {
    throw new Error(`ringotel: user ${userId} has no extension`);
  }
  return { name: user.name, email: ringotelEmail(user.email), ext };
}

/**
 * `[{ number, title }]` for `exts`, in the caller's order: the extension's owner name, or
 * "Parking <ext>" (§10.4 BLF). An entry with no live `extensions` row is dropped.
 */
export async function blfEntries(
  db: Db,
  exts: string[]
): Promise<{ number: string; title: string }[]> {
  if (exts.length === 0) {
    return [];
  }
  const rows = await db
    .selectFrom('extensions')
    .select(['ext', 'userId', 'ringGroupId'])
    .where('ext', 'in', exts)
    .execute();
  const userIds = rows.flatMap(row => (row.userId ? [row.userId] : []));
  const groupIds = rows.flatMap(row =>
    row.ringGroupId ? [row.ringGroupId] : []
  );
  const users =
    userIds.length > 0
      ? await db
          .selectFrom('users')
          .select(['id', 'name'])
          .where('id', 'in', userIds)
          .execute()
      : [];
  const groups =
    groupIds.length > 0
      ? await db
          .selectFrom('ringGroups')
          .select(['id', 'name'])
          .where('id', 'in', groupIds)
          .execute()
      : [];
  const userName = new Map(users.map(row => [row.id, row.name]));
  const groupName = new Map(groups.map(row => [row.id, row.name]));
  const rowByExt = new Map(rows.map(row => [row.ext, row]));
  return exts.flatMap(ext => {
    const row = rowByExt.get(ext);
    if (!row) {
      return [];
    }
    return [
      {
        number: row.ext,
        title:
          (row.userId ? userName.get(row.userId) : undefined) ??
          (row.ringGroupId ? groupName.get(row.ringGroupId) : undefined) ??
          `Parking ${row.ext}`
      }
    ];
  });
}

/**
 * The `createdAt` of the most recent audit event that deleted `device` since it was created: its
 * own `devices.delete`, or a `users.delete` of its owner, whose cascade soft-deletes the user's
 * devices (§5.9). `audit_log` is append-only (§11.1), so this survives undo resetting the rows'
 * own `deletedAt`; `null` when the device was never deleted.
 */
export async function lastDeviceDeletionAt(
  db: Db,
  device: Pick<DeviceRow, 'id' | 'userId' | 'createdAt'>
): Promise<string | null> {
  const row = await db
    .selectFrom('auditLog')
    .select('createdAt')
    .where(eb =>
      eb.or([
        eb.and([
          eb('entityKind', '=', 'device'),
          eb('entityId', '=', device.id),
          eb('operation', '=', 'devices.delete')
        ]),
        eb.and([
          eb('entityKind', '=', 'user'),
          eb('entityId', '=', device.userId),
          eb('operation', '=', 'users.delete')
        ])
      ])
    )
    .where('createdAt', '>=', device.createdAt)
    .orderBy('createdAt', 'desc')
    .executeTakeFirst();
  return row?.createdAt ?? null;
}

/** The device's stored BLF panel (§11.2 `device_blf_keys`), in position order. */
export async function deviceBlfKeys(
  db: Db,
  deviceId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('deviceBlfKeys')
    .select('ext')
    .where('deviceId', '=', deviceId)
    .orderBy('position')
    .execute();
  return rows.map(row => row.ext);
}

/**
 * The branch's default `blfs` list (§10.4 "Colleague presence"): every user and group extension
 * in the tenant (§11.2 `device_blf_keys`). Parking slots are left out, since the branch's
 * `callpark.slots` already shows them; a device panel may still name one (`PUT /devices/{id}/blf`).
 */
export async function branchBlfEntries(
  db: Db
): Promise<{ number: string; title: string }[]> {
  const rows = await db
    .selectFrom('extensions')
    .select('ext')
    .where('isParkingSlot', '=', 0)
    .orderBy('ext')
    .execute();
  return blfEntries(
    db,
    rows.map(row => row.ext)
  );
}

export async function loadAllLiveExtensions(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('extensions')
    .select('ext')
    .orderBy('ext')
    .execute();
  return rows.map(row => row.ext);
}

export type RemoteUser = {
  id: string;
  extension: string;
  username?: string;
  domain?: string;
};

/**
 * The Ringotel user id for `ext`, resolved via `getUsers` since Zamfono stores no such id, or
 * `null` when Ringotel holds no user there; the caller decides what a missing user means for its
 * own hook.
 */
export async function findRingotelUserId(
  client: RingotelClient,
  orgId: string,
  branchId: string,
  ext: string
): Promise<string | null> {
  const users = await client.call<RemoteUser[]>('getUsers', {
    orgid: orgId,
    branchid: branchId
  });
  return users.find(user => user.extension === ext)?.id ?? null;
}

/**
 * The organization's `domain`, which `recoverDeletedUser` takes (§10.4 recovery). `settings`
 * keeps only the organization's id (§11.4), so the domain is read off the organization itself
 * via `getOrganizations`; it holds no matter how many users the organization has left.
 */
export async function resolveDomain(
  client: RingotelClient,
  orgId: string
): Promise<string> {
  const organizations =
    await client.call<{ id: string; domain: string }[]>('getOrganizations');
  const domain = organizations.find(org => org.id === orgId)?.domain;
  if (domain === undefined) {
    throw new Error(`ringotel: organization ${orgId} not found`);
  }
  return domain;
}

/** The live `ringotel` device's `sipUsername` for `userId`, or `null` (§11.2 one-per-user). */
export async function ringotelSipUsername(
  db: Db,
  userId: string
): Promise<string | null> {
  const row = await db
    .selectFrom('devices')
    .select('sipUsername')
    .where('userId', '=', userId)
    .where('kind', '=', 'ringotel')
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  return row?.sipUsername ?? null;
}

/** The current `ringotelOrgId`/`ringotelBranchId`; throws while setup has not run yet (§10.4). */
export async function resolveIds(
  db: Db
): Promise<{ orgId: string; branchId: string }> {
  const settings = await loadSettings(db);
  if (settings.ringotelOrgId === null || settings.ringotelBranchId === null) {
    throw new Error('ringotel: provisioning/ringotel/setup has not run yet');
  }
  return { orgId: settings.ringotelOrgId, branchId: settings.ringotelBranchId };
}
