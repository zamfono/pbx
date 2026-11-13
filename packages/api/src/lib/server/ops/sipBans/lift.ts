import { z } from 'zod';

import { HTTP_CONFLICT, HTTP_NOT_FOUND, type Db } from '@zamfono/shared';

import { activeSipBans } from '#lib/server/sipBanList.js';

import { recordChange, setUndoable } from '../audit.js';
import { idOutput } from '../rows.js';
import { defineOperation, OpError } from '../types.js';
import { renderSipBanListAfterCommit } from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** The address and protocol of ban `id`, 404 for an unknown one. */
async function bannedSource(
  db: Db,
  id: string
): Promise<{ address: string; protocol: string }> {
  const ban = await db
    .selectFrom('sipBans')
    .select(['address', 'protocol'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!ban) {
    throw new OpError(HTTP_NOT_FOUND, `SIP ban '${id}' not found`);
  }
  return ban;
}

/** `DELETE /sipBans/{id}` (§5.6, §10.3 "SIP bans"): ends an active ban now, its row kept. */
export const lift = defineOperation({
  name: 'sipBans.lift',
  description:
    'Ends an active SIP ban now, a permanent one included, on its protocol alone; the ban stays listed as ended',
  input: inputSchema,
  output: idOutput,
  problems: [HTTP_NOT_FOUND, HTTP_CONFLICT],
  minRole: 'admin',
  confirm: async (ctx, input) => {
    const { address, protocol } = await bannedSource(ctx.db, input.id);
    return `Lift the SIP ban of ${address} over ${protocol}? This cannot be undone.`;
  },
  entity: input => ({ kind: 'sipBan', id: input.id }),
  run: async (ctx, input) => {
    await bannedSource(ctx.db, input.id);
    const active = await activeSipBans(ctx.db, ctx.now)
      .select('id')
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (!active) {
      throw new OpError(HTTP_CONFLICT, 'sipBans: the ban has already ended');
    }
    await ctx.db
      .updateTable('sipBans')
      .set({ liftedAt: ctx.now, liftedBy: ctx.actor.id })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'liftedAt', from: null, to: ctx.now });
    // A ban is a security artifact without undo (§11.1).
    setUndoable(ctx, false);
    renderSipBanListAfterCommit(ctx);
    return { id: input.id };
  }
});
