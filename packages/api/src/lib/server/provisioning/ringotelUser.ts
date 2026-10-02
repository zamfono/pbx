/**
 * The Ringotel user behind one `ringotel` device (§10.4 "User"): created by `createUser`, and
 * looked up again by extension, since Zamfono stores no Ringotel id. A `ringotel` device is the
 * user's Ringotel account and "for a provisioned device [the SIP credentials] are pushed to the
 * provider" (§5.2), so a device whose Ringotel user is missing is provisioned when one of its
 * hooks next needs that user, rather than failing the Zamfono operation.
 */
import * as env from '$app/env/private';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import { decrypt, keyringFromEnv } from '../secretbox.js';
import { ringotelLog } from './ringotelBranchHooks.js';
import { RingotelError, type RingotelProviderDeps } from './ringotelClient.js';
import {
  blfEntries,
  deviceBlfKeys,
  findRingotelUserId,
  resolveIds,
  userProfile
} from './ringotelRoster.js';
import type { DeviceRow, SipCredentials } from './types.js';

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

/** The device's stored SIP credentials, decrypted (§5.4). */
export function storedCredentials(device: DeviceRow): SipCredentials {
  return {
    username: device.sipUsername,
    password: decrypt(keyringFromEnv(env), device.sipPasswordEnc).toString(
      'utf8'
    )
  };
}

/**
 * The Ringotel user id of `device`, whose owner holds `ext`; a missing user is created with the
 * device's stored credentials and logged at `warn`, since it means the device was created before
 * `provisioning.ringotelSetup` or its user was removed in the Ringotel Shell.
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
  return createRemoteUser(deps, device, storedCredentials(device));
}

/** `createUser` for one existing device, then its stored panel as `options.blfs` if it has one. */
async function provisionDevice(
  deps: RingotelProviderDeps,
  orgId: string,
  device: DeviceRow
): Promise<string> {
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

/** What Ringotel answered for one existing device: its new user's id, or why it refused. */
export type ExistingDeviceOutcome = { deviceId: string } & (
  { remoteId: string } | { reason: string }
);

/**
 * Provisions every live `ringotel` device that exists when `provisioning.ringotelSetup` creates
 * the organization and connection: while none existed, no provider could run `onDeviceCreated`
 * (§10.4), so each gets its `createUser` now, with its stored credentials, and its stored panel.
 * `createUser` rather than `onDeviceCreated`, since a Ringotel user never existed for any of
 * them, so there is no deleted user to recover. A device Ringotel refuses leaves the others and
 * the setup standing, as a device's push does after its own operation; its outcome says why.
 */
export async function provisionExistingDevices(
  deps: RingotelProviderDeps
): Promise<ExistingDeviceOutcome[]> {
  const { orgId } = await resolveIds(deps.db);
  const devices = await liveRingotelDevices(deps.db);
  const outcomes: ExistingDeviceOutcome[] = [];
  for (const device of devices) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the Ringotel RPC has no batch create; sequential pushes are the plain reading of the API
      const remoteId = await provisionDevice(deps, orgId, device);
      outcomes.push({ deviceId: device.id, remoteId });
    } catch (error) {
      const reason = errorMessage(error);
      outcomes.push({ deviceId: device.id, reason });
    }
  }
  return outcomes;
}
