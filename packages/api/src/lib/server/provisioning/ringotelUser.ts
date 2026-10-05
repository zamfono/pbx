/**
 * The Ringotel user behind one `ringotel` device (§10.4 "User"): created by `createUser`, and
 * looked up again by extension, since Zamfono stores no Ringotel id. A `ringotel` device is the
 * user's Ringotel account and "for a provisioned device [the SIP credentials] are pushed to the
 * provider" (§5.2), so a device whose Ringotel user is missing is provisioned when one of its
 * hooks next needs that user, rather than failing the Zamfono operation.
 */
import * as env from '$app/env/private';

import { MS_PER_DAY, nowIso, type Db } from '@zamfono/shared';

import { decrypt, keyringFromEnv } from '../secretbox.js';
import { ringotelLog } from './ringotelBranchHooks.js';
import { RingotelError, type RingotelProviderDeps } from './ringotelClient.js';
import {
  blfEntries,
  deviceBlfKeys,
  findRingotelUserId,
  lastDeviceDeletionAt,
  resolveDomain,
  resolveIds,
  userProfile
} from './ringotelRoster.js';
import type { DeviceRow, PushReceipt, SipCredentials } from './types.js';

// Ringotel's recoverDeletedUser (§10.4) accepts a deletion only within this window; after it,
// a device gets a fresh createUser.
const RECOVER_WINDOW_MS = MS_PER_DAY;

/** `createUser` for `device` with the §10.4 "`createUser` parameters"; returns the new id. */
export async function createRemoteUser(
  deps: RingotelProviderDeps,
  device: DeviceRow,
  sipCredentials: SipCredentials
): Promise<string> {
  const { orgId, branchId } = await resolveIds(deps.db);
  const { name, email, ext } = await userProfile(deps.db, device.userId);
  // `null`, or no `id`, where Ringotel created nothing (checked below).
  const created = await deps.client.call<{ id?: unknown } | null>(
    'createUser',
    {
      orgid: orgId,
      branchid: branchId,
      name,
      email,
      extension: ext,
      username: sipCredentials.username,
      authname: sipCredentials.username,
      password: sipCredentials.password,
      status: 1
    }
  );
  // A user that was not created must never pass for one that was (§10.4): the device would
  // stand with no Ringotel user behind it, and nothing would say so.
  if (created === null || typeof created.id !== 'string' || created.id === '') {
    throw new RingotelError(
      'createUser',
      `answered without a user id: ${JSON.stringify(created)}`
    );
  }
  return created.id;
}

/**
 * The Ringotel user for a device that has none (§10.4): `createUser` for a genuinely new device;
 * `recoverDeletedUser` instead when `device` was deleted within Ringotel's 24 h undo window
 * (`RECOVER_WINDOW_MS`), so a restored device keeps its Ringotel user and app logins. The
 * deletion time comes from the append-only `audit_log`, not the device row's own `deletedAt`,
 * since `audit.undo` (§5.8) clears that column before this would see it.
 */
export async function provisionRemoteUser(
  deps: RingotelProviderDeps,
  device: DeviceRow,
  sipCredentials: SipCredentials
): Promise<PushReceipt> {
  const { orgId } = await resolveIds(deps.db);
  const { name, email, ext } = await userProfile(deps.db, device.userId);
  const nowMs = Date.parse((deps.now ?? nowIso)());
  const deletedAt = await lastDeviceDeletionAt(deps.db, device);
  const isRecovery =
    deletedAt !== null && nowMs - Date.parse(deletedAt) <= RECOVER_WINDOW_MS;
  if (isRecovery) {
    const domain = await resolveDomain(deps.client, orgId);
    const recovered = await deps.client.call<{ id?: unknown } | null>(
      'recoverDeletedUser',
      {
        domain,
        name,
        email,
        extension: ext,
        username: sipCredentials.username,
        authname: sipCredentials.username,
        password: sipCredentials.password
      }
    );
    return typeof recovered?.id === 'string'
      ? { remoteId: recovered.id }
      : null;
  }
  return { remoteId: await createRemoteUser(deps, device, sipCredentials) };
}

/** The device's stored SIP credentials, decrypted (§5.4). */
export function storedCredentials(device: DeviceRow): SipCredentials {
  return {
    username: device.sipUsername,
    password: decrypt(
      keyringFromEnv(env),
      'devices.sipPasswordEnc',
      device.sipPasswordEnc
    ).toString('utf8')
  };
}

/**
 * The Ringotel user id of `device`, whose owner holds `ext`; a missing user is provisioned
 * (`provisionRemoteUser`) with the device's stored credentials and logged at `warn`, since it
 * means the device was created before `provisioning.ringotelSetup`, its user was removed in the
 * Ringotel Shell, or the push of its restoration was lost.
 */
export async function ensureRemoteUser(
  deps: RingotelProviderDeps,
  device: DeviceRow,
  ext: string
): Promise<string> {
  const { orgId, branchId } = await resolveIds(deps.db);
  const remoteId = await findRingotelUserId(deps.client, orgId, branchId, ext);
  if (remoteId !== null) {
    return remoteId;
  }
  ringotelLog.warn(
    { deviceId: device.id, ext },
    'ringotel: no Ringotel user for this ringotel device; creating it'
  );
  const receipt = await provisionRemoteUser(
    deps,
    device,
    storedCredentials(device)
  );
  const provisioned =
    receipt?.remoteId ??
    (await findRingotelUserId(deps.client, orgId, branchId, ext));
  if (provisioned === null) {
    throw new RingotelError(
      'recoverDeletedUser',
      'recovered no user at the extension'
    );
  }
  return provisioned;
}

/**
 * Provisions a live `ringotel` device that existed when `provisioning.ringotelSetup` or
 * `provisioning.ringotelAdopt` set Ringotel up: while no organization existed, no provider could
 * run `onDeviceCreated` (§10.4), so it gets its `createUser` now, with its stored credentials, and
 * its stored panel as `options.blfs` if it has one; returns the new user's id. `createUser`
 * rather than `onDeviceCreated`, since a Ringotel user never existed for it, so there is no
 * deleted user to recover.
 */
export async function provisionExistingDevice(
  deps: RingotelProviderDeps,
  device: DeviceRow
): Promise<string> {
  const { orgId } = await resolveIds(deps.db);
  const remoteId = await createRemoteUser(
    deps,
    device,
    storedCredentials(device)
  );
  const keys = await deviceBlfKeys(deps.db, device.id);
  if (keys.length > 0) {
    await deps.client.call('updateUser', {
      orgid: orgId,
      id: remoteId,
      options: { blfs: await blfEntries(deps.db, keys) }
    });
  }
  return remoteId;
}

/** Every live `ringotel` device, oldest first. */
export async function liveRingotelDevices(db: Db): Promise<DeviceRow[]> {
  return db
    .selectFrom('devices')
    .selectAll()
    .where('kind', '=', 'ringotel')
    .where('deletedAt', 'is', null)
    .orderBy('createdAt')
    .execute();
}
