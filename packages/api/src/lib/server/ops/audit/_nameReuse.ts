import type { Context } from '../types.js';
import type { Collision } from './_shared.js';

/** The live ring group already using a revived ring group's name (§5.8, §5.9). */
export async function ringGroupNameConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('ringGroups')
    .select('name')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('ringGroups')
    .select(['id', 'name'])
    .where('name', '=', row.name)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'ringGroup', id: conflict.id, label: conflict.name }
    : null;
}

/** The live user group already using a revived user group's name (§5.8, §5.9). */
export async function userGroupNameConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('userGroups')
    .select('name')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('userGroups')
    .select(['id', 'name'])
    .where('name', '=', row.name)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'userGroup', id: conflict.id, label: conflict.name }
    : null;
}

/** The live menu already using a revived menu's name (§5.8, §5.9). */
export async function menuNameConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('menus')
    .select('name')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('menus')
    .select(['id', 'name'])
    .where('name', '=', row.name)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'menu', id: conflict.id, label: conflict.name }
    : null;
}

/** The live trunk already using a revived trunk's name (§5.8, §5.9). */
export async function trunkNameConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('trunks')
    .select('name')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('trunks')
    .select(['id', 'name'])
    .where('name', '=', row.name)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'trunk', id: conflict.id, label: conflict.name }
    : null;
}
