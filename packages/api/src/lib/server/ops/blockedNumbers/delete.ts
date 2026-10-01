import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';

const STATUS_NOT_FOUND = 404;

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /blockedNumbers/{id}` (§10.3 "Blocklist"): soft-deletes a blocklist entry. */
export const del = defineOperation({
  name: 'blockedNumbers.delete',
  description: 'Removes a number from the tenant blocklist',
  input: inputSchema,
  minRole: 'admin',
  confirm: input => `Unblock ${input.id}?`,
  entity: input => ({ kind: 'blockedNumber', id: input.id }),
  run: async (ctx, input) => {
    const row = await ctx.db
      .selectFrom('blockedNumbers')
      .select('id')
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row) {
      throw new OpError(STATUS_NOT_FOUND, 'blockedNumbers: not found');
    }
    await ctx.db
      .updateTable('blockedNumbers')
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
