import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, OpError, type Context } from '../types.js';

const STATUS_NOT_FOUND = 404;

const inputSchema = z.object({ id: z.string() }).strict();

/**
 * Refuses the delete while the tenant main number points at this DID, or a live user or outbound
 * route still presents it as caller-ID (§5.9, §9.4 "Caller-ID").
 */
async function guardDeletable(ctx: Context, didId: string): Promise<void> {
  const settings = await ctx.db
    .selectFrom('settings')
    .select('mainDidId')
    .executeTakeFirst();
  if (settings?.mainDidId === didId) {
    throw new Conflict('dids: is the tenant main number', [
      { kind: 'settings', id: 'settings', label: 'Main number' }
    ]);
  }
  const users = await ctx.db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('calleridDidId', '=', didId)
    .where('deletedAt', 'is', null)
    .execute();
  if (users.length > 0) {
    throw new Conflict(
      'dids: presented as caller-ID by users',
      users.map(user => ({ kind: 'user', id: user.id, label: user.name }))
    );
  }
  const routes = await ctx.db
    .selectFrom('outboundRoutes')
    .select('id')
    .where('calleridDidId', '=', didId)
    .where('deletedAt', 'is', null)
    .execute();
  if (routes.length > 0) {
    throw new Conflict(
      'dids: presented as caller-ID by outbound routes',
      routes.map(route => ({
        kind: 'outboundRoute',
        id: route.id,
        label: route.id
      }))
    );
  }
}

/** `DELETE /dids/{id}` (§5.9): soft-deletes a DID once nothing still presents it. */
export const del = defineOperation({
  name: 'dids.delete',
  description:
    'Soft-deletes a DID unless it is the main number or presented as caller ID',
  input: inputSchema,
  minRole: 'admin',
  confirm: input => `Delete DID ${input.id}?`,
  entity: input => ({ kind: 'did', id: input.id }),
  run: async (ctx, input) => {
    const did = await ctx.db
      .selectFrom('dids')
      .select('id')
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!did) {
      throw new OpError(STATUS_NOT_FOUND, 'dids: DID not found');
    }
    await guardDeletable(ctx, input.id);
    await ctx.db
      .updateTable('dids')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    // Read by the routing pipeline (§3.1), and nothing in it reaches Asterisk's own
    // configuration, so this drops `core`'s config cache without a reload.
    propagate(ctx, []);
    return { id: input.id };
  }
});
