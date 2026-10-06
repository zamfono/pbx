import { removeMfaMethods, type Db } from '@zamfono/shared';

import { revokeUserPersonalAccessTokens } from '#lib/server/auth/personalAccessTokens.js';
import { revokeUserTokens } from '#lib/server/auth/tokens.js';
import type { DeviceRow } from '#lib/server/provisioning/types.js';

import { recordChange } from '../audit.js';
import { releaseRingotelUsers } from '../devices/_ringotelDeletion.js';
import { loadDroppedBlfKeys } from '../devices/_shared.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { softDelete } from '../rows.js';
import { Conflict, type Context } from '../types.js';
import { userExtension } from './_extensions.js';
import { findUserReferences } from './_references.js';
import { assertNotLastOwner, type UserRow } from './_shared.js';

type DeviceSnapshot = {
  id: string;
  label: string;
  kind: string;
  transport: string;
  sipUsername: string;
};

async function loadLiveDevices(db: Db, userId: string): Promise<DeviceRow[]> {
  return db
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
 * Refuses deleting `user` (§5.9): the last owner (409), or a user something still references
 * (409 naming it), until the admin retargets the reference.
 */
export async function assertDeletable(
  db: Db,
  user: Pick<UserRow, 'id' | 'role' | 'passwordHash'>
): Promise<void> {
  await assertNotLastOwner(db, user);
  const references = await findUserReferences(db, user.id);
  if (references.length > 0) {
    throw new Conflict('user is still in use', references);
  }
}

/**
 * The `prepare` of `users.delete` and `users.erase` for a live `user`: refuses what the deletion
 * would (`assertDeletable`), then deletes the user's Ringotel users (§10.4) before the
 * transaction opens (`releaseRingotelUsers`). `run` checks `assertDeletable` again inside the
 * transaction, then calls the returned `release`.
 */
export async function releaseUser(
  ctx: Context,
  user: Pick<UserRow, 'id' | 'role' | 'passwordHash'>
): Promise<() => void> {
  await assertDeletable(ctx.db, user);
  return releaseRingotelUsers(ctx, await loadLiveDevices(ctx.db, user.id));
}

/**
 * Soft-deletes `userId` and cascades per §5.9: their devices, their extension row (dropping the
 * BLF keys that watched it through the FK), their sessions, personal access tokens and second
 * factors, recording every dropped row in the audit diff for undo. Shared by `users.delete` and `users.erase` (§5.10).
 */
export async function cascadeSoftDeleteUser(
  ctx: Context,
  userId: string
): Promise<void> {
  const ext = await userExtension(ctx.db, userId);
  const [devices, droppedBlfKeys] = await Promise.all([
    loadLiveDevices(ctx.db, userId),
    ext === null ? [] : loadDroppedBlfKeys(ctx, ext)
  ]);
  await softDelete(ctx, 'users', userId);
  await ctx.db
    .updateTable('devices')
    .set({ deletedAt: ctx.now })
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null)
    .execute();
  await ctx.db.deleteFrom('extensions').where('userId', '=', userId).execute();
  await pushRoster(ctx);
  await revokeUserTokens(ctx.db, userId, ctx.now);
  await revokeUserPersonalAccessTokens(ctx.db, userId, ctx.now);
  await removeMfaMethods(ctx.db, userId);
  // Recorded under `ext`, the field name `audit.undo` special-cases to re-insert the dropped
  // `extensions` row (§5.9); `users.update`'s own rename field is `extension` (§10.3).
  if (ext !== null) {
    recordChange(ctx, { field: 'ext', from: ext, to: null });
  }
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
  recordChange(ctx, { field: 'mfaRemoved', from: false, to: true });
  propagate(ctx, ['pjsip', 'dialplan']);
}
