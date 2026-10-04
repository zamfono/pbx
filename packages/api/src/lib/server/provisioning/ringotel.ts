import {
  ringotelLog,
  ringotelPbxRestarted,
  ringotelRosterChanged,
  ringotelTenantProfileChanged
} from './ringotelBranchHooks.js';
import type { RingotelProviderDeps } from './ringotelClient.js';
import {
  blfEntries,
  extensionOfUser,
  findRingotelUserId,
  resolveIds,
  userProfile
} from './ringotelRoster.js';
import { ensureRemoteUser, provisionRemoteUser } from './ringotelUser.js';
import type {
  DeviceRow,
  ProvisioningProvider,
  PushReceipt,
  SipCredentials
} from './types.js';

/**
 * `onDeviceDeleted` (§10.4): `deleteUser`, resolved via `getUsers` since Zamfono keeps no id. A
 * device without a Ringotel user has nothing to free at Ringotel, so its deletion proceeds with a
 * logged warning.
 */
async function ringotelDeviceDeleted(
  deps: RingotelProviderDeps,
  device: DeviceRow
): Promise<void> {
  const { orgId, branchId } = await resolveIds(deps.db);
  const ext = await extensionOfUser(deps.db, device.userId);
  if (ext === null) {
    return;
  }
  const remoteId = await findRingotelUserId(deps.client, orgId, branchId, ext);
  if (remoteId === null) {
    ringotelLog.warn(
      { deviceId: device.id, ext },
      'ringotel: no Ringotel user for this ringotel device; nothing to delete'
    );
    return;
  }
  await deps.client.call('deleteUser', { orgid: orgId, id: remoteId });
}

/**
 * `onCredentialsRotated` (§10.4): pushes the new SIP password via `updateUser`; a device without
 * a Ringotel user gets the user `onDeviceCreated` would give it, with the new credentials: one
 * restored within Ringotel's recovery window is recovered, so a restored device whose own push
 * was lost keeps its app logins.
 */
async function ringotelCredentialsRotated(
  deps: RingotelProviderDeps,
  device: DeviceRow,
  sipCredentials: SipCredentials
): Promise<PushReceipt> {
  const { orgId, branchId } = await resolveIds(deps.db);
  const { ext } = await userProfile(deps.db, device.userId);
  const remoteId = await findRingotelUserId(deps.client, orgId, branchId, ext);
  if (remoteId === null) {
    ringotelLog.warn(
      { deviceId: device.id, ext },
      'ringotel: no Ringotel user for this ringotel device; creating it'
    );
    return provisionRemoteUser(deps, device, sipCredentials);
  }
  await deps.client.call('updateUser', {
    orgid: orgId,
    id: remoteId,
    password: sipCredentials.password
  });
  return { remoteId };
}

/**
 * `onDeviceBlfChanged` (§10.4): pushes the device's panel as `updateUser options.blfs`, to the
 * Ringotel user `ensureRemoteUser` provisions first if it is missing.
 */
async function ringotelBlfChanged(
  deps: RingotelProviderDeps,
  device: DeviceRow,
  keys: string[]
): Promise<void> {
  const { orgId } = await resolveIds(deps.db);
  const ext = await extensionOfUser(deps.db, device.userId);
  if (ext === null) {
    return;
  }
  const remoteId = await ensureRemoteUser(deps, device, ext);
  const blfs = await blfEntries(deps.db, keys);
  await deps.client.call('updateUser', {
    orgid: orgId,
    id: remoteId,
    options: { blfs }
  });
}

/** `ringotel` (§10.4): drives the Ringotel Admin API for the seven `ProvisioningProvider` hooks. */
export function createRingotelProvider(
  deps: RingotelProviderDeps
): ProvisioningProvider {
  return {
    onDeviceCreated: (device, sipCredentials) =>
      provisionRemoteUser(deps, device, sipCredentials),
    onDeviceDeleted: device => ringotelDeviceDeleted(deps, device),
    onCredentialsRotated: (device, sipCredentials) =>
      ringotelCredentialsRotated(deps, device, sipCredentials),
    onDeviceBlfChanged: (device, keys) =>
      ringotelBlfChanged(deps, device, keys),
    onRosterChanged: users => ringotelRosterChanged(deps, users),
    onTenantProfileChanged: settings =>
      ringotelTenantProfileChanged(deps, settings),
    onPbxRestarted: () => ringotelPbxRestarted(deps)
  };
}
