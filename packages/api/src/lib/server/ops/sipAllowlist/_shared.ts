import { z } from 'zod';

import { addressRangesOverlap } from '@zamfono/shared';

import { activeSipBans } from '#lib/server/sipBanList.js';

import type { Context } from '../types.js';

/** An allowlist entry's wire shape (§10.3 "SIP bans"). */
export const sipAllowlistEntryWire = z.object({
  id: z.string(),
  address: z.string(),
  label: z.string().nullable(),
  createdAt: z.string()
});

/**
 * Ends every active ban `address` covers, recorded as lifted by `ctx`'s actor (§5.6): a live
 * allowlist entry, a new one or one an undo restores, never stands beside a ban it covers.
 */
export async function liftCoveredBans(
  ctx: Context,
  address: string
): Promise<void> {
  const bans = await activeSipBans(ctx.db, ctx.now)
    .select(['id', 'address'])
    .execute();
  const covered = bans
    .filter(ban => addressRangesOverlap(address, ban.address))
    .map(ban => ban.id);
  if (covered.length === 0) {
    return;
  }
  await ctx.db
    .updateTable('sipBans')
    .set({ liftedAt: ctx.now, liftedBy: ctx.actor.id })
    .where('id', 'in', covered)
    .execute();
}
