import type { Context } from '../types.js';
import type { Collision } from './_shared.js';

/**
 * The live schedule of the same scope a revived opening-hours schedule would collide with: one
 * live schedule per user, ring group or menu (`opening_hours_scope_*`) and one tenant schedule
 * (`opening_hours_tenant_single`, §11.2). `hours.set` on a scope whose schedule is soft-deleted
 * inserts a new one, so undoing the old schedule's `hours.delete` would bring back a second.
 */
export async function scheduleReuseConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('openingHours')
    .select(['scopeUserId', 'scopeRingGroupId', 'scopeMenuId'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('openingHours')
    .select('id')
    .where(
      'scopeUserId',
      row.scopeUserId === null ? 'is' : '=',
      row.scopeUserId
    )
    .where(
      'scopeRingGroupId',
      row.scopeRingGroupId === null ? 'is' : '=',
      row.scopeRingGroupId
    )
    .where(
      'scopeMenuId',
      row.scopeMenuId === null ? 'is' : '=',
      row.scopeMenuId
    )
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'openingHours', id: conflict.id, label: 'opening hours' }
    : null;
}
