import type { ReloadKind } from '@zamfono/shared';

import { propagate } from '../runner.js';
import { Conflict, OpError, type Context } from '../types.js';
import { guardReuseConflict } from './_reuseConflicts.js';
import { ENTITY_TABLES } from './_shared.js';

const STATUS_CONFLICT = 409;

/**
 * The reload kinds an entity kind's own `create`/`delete` propagate (§3.1 config propagation),
 * replayed identically here: restoring the row has to reach the rendered PJSIP/dialplan
 * configuration the same way removing it did. A kind absent here is one whose own delete
 * propagates nothing, config for it being read live rather than rendered to a file.
 */
const DELETE_PROPAGATE_KINDS: Partial<Record<string, ReloadKind[]>> = {
  user: ['pjsip', 'dialplan'],
  device: ['pjsip'],
  ringGroup: ['pjsip', 'dialplan'],
  trunk: ['pjsip'],
  userGroup: ['pjsip']
};

/** `extensions.userId`/`ringGroupId` for the entity kind an `ext` change belongs to (§11.2). */
function extensionOwner(
  entityKind: string,
  entityId: string
): { userId: string | null; ringGroupId: string | null } {
  return {
    userId: entityKind === 'user' ? entityId : null,
    ringGroupId: entityKind === 'ringGroup' ? entityId : null
  };
}

/**
 * Re-inserts the `extensions` row a user's or ring group's own delete cascade dropped (§5.9),
 * refused with the row naming it if the extension has been taken since (§5.8).
 */
export async function revertExtension(
  ctx: Context,
  entityKind: string,
  entityId: string,
  ext: string
): Promise<void> {
  const taken = await ctx.db
    .selectFrom('extensions')
    .select('ext')
    .where('ext', '=', ext)
    .executeTakeFirst();
  if (taken) {
    throw new Conflict('the extension has been taken since', [
      { kind: 'extension', id: ext, label: ext }
    ]);
  }
  const owner = extensionOwner(entityKind, entityId);
  await ctx.db
    .insertInto('extensions')
    .values({
      ext,
      userId: owner.userId,
      ringGroupId: owner.ringGroupId,
      isParkingSlot: 0
    })
    .execute();
}

/**
 * Un-soft-deletes the devices a user's own delete cascade soft-deleted (§5.9), each refused like
 * a device's own undo if a newer live device has taken its SIP username since (§5.8).
 */
export async function revertDevices(
  ctx: Context,
  devices: { id: string }[]
): Promise<void> {
  for (const device of devices) {
    // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; each row updates in turn
    await guardReuseConflict(ctx, 'device', device.id);
    // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; each row updates in turn
    await ctx.db
      .updateTable('devices')
      .set({ deletedAt: null })
      .where('id', '=', device.id)
      .execute();
  }
}

/** Re-inserts the `device_blf_keys` rows the extension's own removal cascaded away (§5.9). */
export async function revertBlfKeys(
  ctx: Context,
  keys: { deviceId: string; ext: string; position: number }[]
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  await ctx.db.insertInto('deviceBlfKeys').values(keys).execute();
}

/** Sets `deleted_at` back to `NULL` on the reverted entity's own row (§5.9). */
export async function revertSoftDelete(
  ctx: Context,
  entityKind: string,
  entityId: string
): Promise<void> {
  const table = ENTITY_TABLES[entityKind];
  if (!table) {
    throw new OpError(
      STATUS_CONFLICT,
      `audit.undo: entity kind '${entityKind}' has no soft-delete table`
    );
  }
  await guardReuseConflict(ctx, entityKind, entityId);
  await ctx.db
    .updateTable(table)
    .set({ deletedAt: null })
    .where('id', '=', entityId)
    .execute();
  const kinds = DELETE_PROPAGATE_KINDS[entityKind];
  if (kinds) {
    propagate(ctx, kinds);
  }
}
