import type { Context } from '../types.js';
import type { Collision } from './_shared.js';

/** The live DID already holding a revived DID's number (§5.8, §5.9). */
export async function didNumberConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('dids')
    .select('number')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('dids')
    .select(['id', 'number'])
    .where('number', '=', row.number)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'did', id: conflict.id, label: conflict.number }
    : null;
}

/** The live DID block already starting at a revived block's base (§5.8, §5.9). */
export async function didBlockBaseConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('didBlocks')
    .select('base')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('didBlocks')
    .select(['id', 'base'])
    .where('base', '=', row.base)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'didBlock', id: conflict.id, label: conflict.base }
    : null;
}

/** The live blocked-number entry already listing a revived entry's number and match kind (§5.8, §5.9). */
export async function blockedNumberConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('blockedNumbers')
    .select(['number', 'isPrefix'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('blockedNumbers')
    .select(['id', 'number'])
    .where('number', '=', row.number)
    .where('isPrefix', '=', row.isPrefix)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'blockedNumber', id: conflict.id, label: conflict.number }
    : null;
}
