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
  lastDeviceDeletionAt,
  resolveDomain,
  resolveIds,
  userProfile
} from './ringotelRoster.js';
import { createRemoteUser, ensureRemoteUser } from './ringotelUser.js';
import type {
  DeviceRow,
  ProvisioningProvider,
  PushReceipt,
  SipCredentials
} from './types.js';

export { buildBranchProvision } from './branchProvision.js';
export type { RingotelProviderDeps } from './ringotelClient.js';

// Ringotel's recoverDeletedUser (§10.4) accepts a deletion only within this window; after it,
// onDeviceCreated falls back to a fresh createUser.
const RECOVER_WINDOW_MS = 86_400_000;

/**
 * `onDeviceCreated` (§10.4): `createUser` for a genuinely new device; `recoverDeletedUser`
 * instead when `device` was deleted within Ringotel's 24 h undo window (`RECOVER_WINDOW_MS`). The
 * deletion time comes from the append-only `audit_log`, not the device row's own `deletedAt`,
 * since `audit.undo` (§5.8) clears that column before this hook would see it.
 */
async function ringotelDeviceCreated(
  deps: RingotelProviderDeps,
  device: DeviceRow,
  sipCredentials: SipCredentials
): Promise<PushReceipt> {
  const { orgId } = await resolveIds(deps.db);
  const { name, email, ext } = await userProfile(deps.db, device.userId);
  const nowMs = Date.parse(deps.now ? deps.now() : new Date().toISOString());
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
 * a Ringotel user gets its `createUser` with the new credentials instead, which pushes them too.
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
    return { remoteId: await createRemoteUser(deps, device, sipCredentials) };
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
      ringotelDeviceCreated(deps, device, sipCredentials),
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
