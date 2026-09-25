import type { Context } from '../types.js';
import { trunkNameConflict } from './_nameReuse.js';
import type { Collision } from './_shared.js';

/**
 * The live trunk already holding a revived trunk's priority (`trunks_priority`, §11.2): a trunk
 * created since appends past every live trunk, and `trunks.setOrder` renumbers the live ones from
 * 1, so either can take the position a soft-deleted trunk left behind (§9.4 "Trunk order").
 */
async function trunkPriorityConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('trunks')
    .select('priority')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('trunks')
    .select(['id', 'name'])
    .where('priority', '=', row.priority)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'trunk', id: conflict.id, label: conflict.name }
    : null;
}

/**
 * The live row a revived trunk would collide with, over either of the two values `trunks` keeps
 * unique among live rows: the name and the priority (§5.8, §11.2).
 */
export async function trunkReuseConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  return (
    (await trunkNameConflict(ctx, id)) ?? (await trunkPriorityConflict(ctx, id))
  );
}
