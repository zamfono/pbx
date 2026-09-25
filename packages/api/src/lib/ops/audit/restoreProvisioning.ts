/**
 * Undoing a delete has to reach the provisioning provider the same way the delete did (§10.4
 * "Configuration and lifecycle"): `onDeviceDeleted` removed the Ringotel user when the row was
 * soft-deleted, so restoring the row pushes it back. `onDeviceCreated` is the entry point for
 * that, because it already chooses between recovering a user deleted within Ringotel's own 24-hour
 * window and creating a fresh one after it.
 */
import { activeRingotelProvider } from '../../provisioning/index.js';
import type { DeviceRow } from '../../provisioning/types.js';
import { decrypt, keyringFromEnv } from '../../secretbox.js';
import type { Context } from '../types.js';

const RINGOTEL_KIND = 'ringotel';

/** The devices a restored entity brings back: a device's own row, or every device of a user. */
async function restoredDevices(
  ctx: Context,
  entityKind: string,
  entityId: string
): Promise<DeviceRow[]> {
  if (entityKind === 'device') {
    return ctx.db
      .selectFrom('devices')
      .selectAll()
      .where('id', '=', entityId)
      .where('deletedAt', 'is', null)
      .execute();
  }
  if (entityKind === 'user') {
    return ctx.db
      .selectFrom('devices')
      .selectAll()
      .where('userId', '=', entityId)
      .where('deletedAt', 'is', null)
      .execute();
  }
  return [];
}

/**
 * Pushes every `ringotel` device a restore brought back. The SIP password is the one already on
 * the row: a restore returns the device exactly as it was, so the phone that holds those
 * credentials keeps working.
 */
export async function restoreProvisionedDevices(
  ctx: Context,
  entityKind: string,
  entityId: string
): Promise<void> {
  const devices = (await restoredDevices(ctx, entityKind, entityId)).filter(
    device => device.kind === RINGOTEL_KIND
  );
  if (devices.length === 0) {
    return;
  }
  const provider = await activeRingotelProvider(ctx.db);
  if (!provider) {
    return;
  }
  const keyring = keyringFromEnv(process.env);
  for (const device of devices) {
    // eslint-disable-next-line no-await-in-loop -- the Ringotel RPC has no batch create; sequential pushes are the plain reading of the API
    await provider.onDeviceCreated(device, {
      username: device.sipUsername,
      password: decrypt(keyring, device.sipPasswordEnc).toString()
    });
  }
}
