import { Conflict, type Context } from '../types.js';
import { deviceReuseConflict } from './_deviceReuse.js';
import {
  menuNameConflict,
  ringGroupNameConflict,
  userGroupNameConflict
} from './_nameReuse.js';
import {
  blockedNumberConflict,
  didBlockBaseConflict,
  didNumberConflict
} from './_numberReuse.js';
import { scheduleReuseConflict } from './_scheduleReuse.js';
import type { Collision } from './_shared.js';
import { trunkReuseConflict } from './_trunkReuse.js';
import { userReuseConflict } from './_userReuse.js';

async function audioFilenameConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('audioAssets')
    .select('filename')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('audioAssets')
    .select(['id', 'label'])
    .where('filename', '=', row.filename)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'audio', id: conflict.id, label: conflict.label }
    : null;
}

/**
 * The reuse-eligible unique-value check for each entity kind whose live-row uniqueness is scoped
 * by `deleted_at IS NULL` (§11.2), so a soft-deleted row's value is free the moment a new row takes
 * it (§5.9) and an undo bringing the old row back must refuse to collide with that new row (§5.8).
 * `outbound_routes_priority` needs no check here: a route comes back only through
 * `outboundRoutes.replace`, which renumbers every route it keeps.
 */
const REUSE_CONFLICT_CHECKS: Partial<
  Record<string, (ctx: Context, id: string) => Promise<Collision | null>>
> = {
  user: userReuseConflict,
  device: deviceReuseConflict,
  ringGroup: ringGroupNameConflict,
  userGroup: userGroupNameConflict,
  menu: menuNameConflict,
  trunk: trunkReuseConflict,
  did: didNumberConflict,
  didBlock: didBlockBaseConflict,
  audio: audioFilenameConflict,
  blockedNumber: blockedNumberConflict,
  openingHours: scheduleReuseConflict
};

/** Refuses the revert with a 409 naming the newer row, if reviving the entity would collide with it. */
export async function guardReuseConflict(
  ctx: Context,
  entityKind: string,
  entityId: string
): Promise<void> {
  const check = REUSE_CONFLICT_CHECKS[entityKind];
  if (!check) {
    return;
  }
  const conflict = await check(ctx, entityId);
  if (conflict) {
    throw new Conflict(`audit.undo: ${entityKind} value already taken`, [
      conflict
    ]);
  }
}
