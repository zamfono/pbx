import type { Context } from '../types.js';
import type { Collision } from './_shared.js';

/** The live device already using a revived device's SIP username (`devices_sip_username`, §11.2). */
async function sipUsernameConflict(
  ctx: Context,
  id: string,
  sipUsername: string
): Promise<Collision | null> {
  const conflict = await ctx.db
    .selectFrom('devices')
    .select(['id', 'label'])
    .where('sipUsername', '=', sipUsername)
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'device', id: conflict.id, label: conflict.label }
    : null;
}

/**
 * The user's live Ringotel device a revived Ringotel device would join, a user having at most one
 * (`devices_one_ringotel_per_user`, §11.2); a manual device collides with nobody here.
 */
async function ringotelConflict(
  ctx: Context,
  id: string,
  row: { userId: string; kind: string }
): Promise<Collision | null> {
  if (row.kind !== 'ringotel') {
    return null;
  }
  const conflict = await ctx.db
    .selectFrom('devices')
    .select(['id', 'label'])
    .where('userId', '=', row.userId)
    .where('kind', '=', 'ringotel')
    .where('deletedAt', 'is', null)
    .where('id', '!=', id)
    .executeTakeFirst();
  return conflict
    ? { kind: 'device', id: conflict.id, label: conflict.label }
    : null;
}

/**
 * The live row a revived device would collide with, over either of the two uniqueness rules
 * `devices` keeps among live rows: the SIP username and one Ringotel device per user (§5.8).
 */
export async function deviceReuseConflict(
  ctx: Context,
  id: string
): Promise<Collision | null> {
  const row = await ctx.db
    .selectFrom('devices')
    .select(['sipUsername', 'userId', 'kind'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  return (
    (await sipUsernameConflict(ctx, id, row.sipUsername)) ??
    (await ringotelConflict(ctx, id, row))
  );
}
