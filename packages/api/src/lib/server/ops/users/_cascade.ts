import { revokeUserTokens } from '#lib/server/auth/tokens.js';
import { activeRingotelProvider } from '#lib/server/provisioning/index.js';
import type { DeviceRow } from '#lib/server/provisioning/types.js';

import { recordChange } from '../audit.js';
import { loadDroppedBlfKeys } from '../devices/_shared.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { softDelete } from '../rows.js';
import type { Context } from '../types.js';
import { userExtension } from './_extensions.js';

type DeviceSnapshot = {
  id: string;
  label: string;
  kind: string;
  transport: string;
  sipUsername: string;
};

async function loadLiveDevices(
  ctx: Context,
  userId: string
): Promise<DeviceRow[]> {
  return ctx.db
    .selectFrom('devices')
    .selectAll()
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null)
    .execute();
}

/** The five device fields the audit diff carries, so undo can restore the deleted rows (§5.9). */
function toSnapshot(device: DeviceRow): DeviceSnapshot {
  return {
    id: device.id,
    label: device.label,
    kind: device.kind,
    transport: device.transport,
    sipUsername: device.sipUsername
  };
}

/**
 * Runs `onDeviceDeleted` for each of `devices` that a provisioning provider holds, so the
 * Ringotel user is deleted and its extension freed at the same moment Zamfono frees it (§10.4
 * "Configuration and lifecycle"). Called while the `extensions` row still exists, since the
 * provider resolves the remote user by the owner's extension.
 */
async function releaseProvisionedDevices(
  ctx: Context,
  devices: DeviceRow[]
): Promise<void> {
  const provisioned = devices.filter(device => device.kind === 'ringotel');
  if (provisioned.length === 0) {
    return;
  }
  const provider = await activeRingotelProvider(ctx.db);
  if (!provider) {
    return;
  }
  for (const device of provisioned) {
    // eslint-disable-next-line no-await-in-loop -- the Ringotel RPC has no batch delete; sequential pushes are the plain reading of the API
    await provider.onDeviceDeleted(device);
  }
}

/**
 * Soft-deletes `userId` and cascades per §5.9: their devices, their extension row (dropping the
 * BLF keys that watched it through the FK) and their sessions, recording every dropped row in the
 * audit diff for undo. Shared by `users.delete` and `users.erase` (§5.10).
 */
export async function cascadeSoftDeleteUser(
  ctx: Context,
  userId: string
): Promise<void> {
  const ext = await userExtension(ctx.db, userId);
  const [devices, droppedBlfKeys] = await Promise.all([
    loadLiveDevices(ctx, userId),
    loadDroppedBlfKeys(ctx, ext)
  ]);
  await softDelete(ctx, 'users', userId);
  await ctx.db
    .updateTable('devices')
    .set({ deletedAt: ctx.now })
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null)
    .execute();
  await releaseProvisionedDevices(ctx, devices);
  await ctx.db.deleteFrom('extensions').where('userId', '=', userId).execute();
  await pushRoster(ctx);
  await revokeUserTokens(ctx.db, userId, ctx.now);
  // Recorded under `ext`, the field name `audit.undo` special-cases to re-insert the dropped
  // `extensions` row (§5.9); `users.update`'s own rename field is `extension` (§10.3).
  recordChange(ctx, { field: 'ext', from: ext, to: null });
  if (devices.length > 0) {
    recordChange(ctx, {
      field: 'devices',
      from: devices.map(toSnapshot),
      to: []
    });
  }
  if (droppedBlfKeys.length > 0) {
    recordChange(ctx, {
      field: 'droppedBlfKeys',
      from: droppedBlfKeys,
      to: []
    });
  }
  recordChange(ctx, { field: 'tokensRevoked', from: false, to: true });
  propagate(ctx, ['pjsip', 'dialplan']);
}
