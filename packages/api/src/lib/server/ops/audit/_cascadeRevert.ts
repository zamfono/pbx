import { HTTP_CONFLICT, type ReloadKind } from '@zamfono/shared';

import { propagate } from '../propagate.js';
import { liftCoveredBans } from '../sipAllowlist/_shared.js';
import { renderSipBanListAfterCommit } from '../sipBans/_shared.js';
import { Conflict, OpError, type Context } from '../types.js';
import { refuseDeletedReferences } from './_deletedReferences.js';
import { guardReuseConflict } from './_reuseConflicts.js';
import { ENTITY_TABLES } from './_shared.js';

/**
 * The reload kinds an entity kind's own `delete` propagates (§3.1 config propagation), replayed
 * identically here: restoring the row has to reach `core`'s config cache and the rendered
 * configuration the same way removing it did. An empty list drops the cache alone, for a row the
 * routing pipeline reads live. A kind absent here is one whose own delete propagates nothing;
 * an audio asset's depends on its kind (`audioReloadKinds`).
 */
const DELETE_PROPAGATE_KINDS: Partial<Record<string, ReloadKind[]>> = {
  user: ['pjsip', 'dialplan'],
  device: ['pjsip'],
  ringGroup: ['pjsip', 'dialplan'],
  trunk: ['pjsip'],
  userGroup: ['pjsip'],
  menu: [],
  did: [],
  didBlock: [],
  oooRule: [],
  blockedNumber: [],
  sipAllowlistEntry: [],
  openingHours: []
};

/** What restoring the deleted audio asset `id` propagates: hold music is rendered (§10.2 "Hold music"). */
async function audioReloadKinds(
  ctx: Context,
  id: string
): Promise<ReloadKind[] | undefined> {
  const asset = await ctx.db
    .selectFrom('audioAssets')
    .select('kind')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return asset.kind === 'moh' ? ['moh'] : undefined;
}

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
  if (devices.length === 0) {
    return;
  }
  const ids = devices.map(device => device.id);
  await Promise.all(ids.map(id => guardReuseConflict(ctx, 'device', id)));
  await ctx.db
    .updateTable('devices')
    .set({ deletedAt: null })
    .where('id', 'in', ids)
    .execute();
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
      HTTP_CONFLICT,
      `audit.undo: entity kind '${entityKind}' has no soft-delete table`
    );
  }
  await guardReuseConflict(ctx, entityKind, entityId);
  await ctx.db
    .updateTable(table)
    .set({ deletedAt: null })
    .where('id', '=', entityId)
    .execute();
  await refuseDeletedReferences(ctx, table, entityId);
  const kinds =
    entityKind === 'audio'
      ? await audioReloadKinds(ctx, entityId)
      : DELETE_PROPAGATE_KINDS[entityKind];
  if (kinds) {
    propagate(ctx, kinds);
  }
  if (entityKind === 'sipAllowlistEntry') {
    const entry = await ctx.db
      .selectFrom('sipAllowlist')
      .select('address')
      .where('id', '=', entityId)
      .executeTakeFirstOrThrow();
    await liftCoveredBans(ctx, entry.address);
    renderSipBanListAfterCommit(ctx);
  }
}
