import type { Selectable } from 'kysely';

import type { DB } from '@zamfono/shared';

export type DeviceRow = Selectable<DB['devices']>;
export type UserRow = Selectable<DB['users']>;
export type SettingsRow = Selectable<DB['settings']>;

/** The credentials a `manual` device's admin enters by hand, or a provider pushes on its behalf. */
export type SipCredentials = { username: string; password: string };

/**
 * What `onDeviceCreated` or `onCredentialsRotated` pushed to: the provider's own id of the user
 * it created or updated, for the audit entry recording the push (§10.4); `null` from a provider
 * that pushes nothing, or when the provider's answer named no id.
 */
export type PushReceipt = { remoteId: string } | null;

/**
 * A device provisioning provider (§10.4): `manual` (no-op, entered by hand) and `ringotel`
 * are the MVP implementations. Every method but the first three is optional, since `manual`
 * has nothing to push for them.
 */
export type ProvisioningProvider = {
  onDeviceCreated(
    device: DeviceRow,
    sipCredentials: SipCredentials
  ): Promise<PushReceipt>;
  onDeviceDeleted(device: DeviceRow): Promise<void>;
  onCredentialsRotated(
    device: DeviceRow,
    sipCredentials: SipCredentials
  ): Promise<PushReceipt>;
  /** `PUT /devices/{id}/blf`: `keys` is the device's ordered extension/slot list. */
  onDeviceBlfChanged?(device: DeviceRow, keys: string[]): Promise<void>;
  /** Any user or extension change: a provider that renders a tenant-wide roster re-renders it. */
  onRosterChanged?(users: UserRow[]): Promise<void>;
  /** `codecs`, `ringotelMaxRegs`, `featureCodes`, `emergencyNumbers`, `country` or `language` changed on the tenant `settings` row. */
  onTenantProfileChanged?(settings: SettingsRow): Promise<void>;
  /** Asterisk restarted and holds no registration: a provider whose apps register re-registers them. */
  onPbxRestarted?(): Promise<void>;
};

/** The `manual` provider: nothing to push, since a manual device is entered into its phone by hand. */
export const noopProvider: ProvisioningProvider = {
  onDeviceCreated: () => Promise.resolve(null),
  onDeviceDeleted: () => Promise.resolve(),
  onCredentialsRotated: () => Promise.resolve(null)
};
