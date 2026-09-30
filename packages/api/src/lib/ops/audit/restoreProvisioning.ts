/**
 * Undoing a delete has to reach the provisioning provider the same way the delete did (§10.4
 * "Configuration and lifecycle"): `onDeviceDeleted` removed the Ringotel user when the row was
 * soft-deleted, so restoring the row pushes it back. `onDeviceCreated` is the entry point for
 * that, because it already chooses between recovering a user deleted within Ringotel's own 24-hour
 * window and creating a fresh one after it.
 */
import type { DeviceRow } from '../../provisioning/types.js';
import { decrypt, keyringFromEnv } from '../../secretbox.js';
import { pushToRingotel } from '../devices/_ringotelPush.js';
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
 * Pushes every `ringotel` device a restore brought back, once the undo has committed and Asterisk
 * holds the restored endpoint (§10.4), like a creation's push: Ringotel registers the user against
 * the PBX before it accepts it. The SIP password is the one already on the row: a restore returns
 * the device exactly as it was, so the phone that holds those credentials keeps working. Each
 * outcome is a `ringotel.push` row with the trigger `audit.undo`, and a refusal a warning of the
 * undo's result.
 */
export async function restoreProvisionedDevices(
  ctx: Context,
  entityKind: string,
  entityId: string
): Promise<void> {
  const devices = (await restoredDevices(ctx, entityKind, entityId)).filter(
    device => device.kind === RINGOTEL_KIND
  );
  for (const device of devices) {
    pushToRingotel(ctx, {
      trigger: 'audit.undo',
      deviceId: device.id,
      push: provider =>
        provider.onDeviceCreated(device, {
          username: device.sipUsername,
          password: decrypt(
            keyringFromEnv(process.env),
            device.sipPasswordEnc
          ).toString()
        }),
      failure: {
        what: `device ${device.id} is restored, but it has no Ringotel user yet`,
        retry: 'devices.rotate on the device creates it'
      }
    });
  }
}
