import type { Selectable } from 'kysely';

import type { DB } from '@zamfono/shared';

export type DeviceRow = Selectable<DB['devices']>;
export type UserRow = Selectable<DB['users']>;
export type SettingsRow = Selectable<DB['settings']>;

/** The credentials a `manual` device's admin enters by hand, or a provider pushes on its behalf. */
export type SipCredentials = { username: string; password: string };

/**
 * A device provisioning provider (§10.4): `manual` (no-op, entered by hand) and `ringotel` (Task
 * 39) are the MVP implementations. Every method but the first three is optional, since `manual`
 * has nothing to push for them.
 */
export type ProvisioningProvider = {
  onDeviceCreated(
    device: DeviceRow,
    sipCredentials: SipCredentials
  ): Promise<void>;
  onDeviceDeleted(device: DeviceRow): Promise<void>;
  onCredentialsRotated(
    device: DeviceRow,
    sipCredentials: SipCredentials
  ): Promise<void>;
  /** `PUT /devices/{id}/blf`: `keys` is the device's ordered extension/slot list. */
  onDeviceBlfChanged?(device: DeviceRow, keys: string[]): Promise<void>;
  /** Any user or extension change: a provider that renders a tenant-wide roster re-renders it. */
  onRosterChanged?(users: UserRow[]): Promise<void>;
  /** `codecs`, `ringotelMaxRegs`, `featureCodes` or `language` changed on the tenant `settings` row. */
  onTenantProfileChanged?(settings: SettingsRow): Promise<void>;
};

/** The `manual` provider: nothing to push, since a manual device is entered into its phone by hand. */
export const noopProvider: ProvisioningProvider = {
  onDeviceCreated: () => Promise.resolve(),
  onDeviceDeleted: () => Promise.resolve(),
  onCredentialsRotated: () => Promise.resolve()
};
