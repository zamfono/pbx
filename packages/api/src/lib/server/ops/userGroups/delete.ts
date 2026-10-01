import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';

const STATUS_NOT_FOUND = 404;

/**
 * Soft-deletes a user group (§5.9): ring-group memberships and outbound-route caller lists that
 * name this group never block the delete, the member simply skipped while soft-deleted (§11.1),
 * so no reference check runs here.
 */
export const deleteUserGroup = defineOperation({
  name: 'userGroups.delete',
  description: 'Soft-deletes a user group.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: input =>
    `Delete this user group? The deletion can be undone for 30 days. (${input.id})`,
  entity: input => ({ kind: 'userGroup', id: input.id }),
  run: async (ctx, input) => {
    const before = await ctx.db
      .selectFrom('userGroups')
      .select('id')
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!before) {
      throw new OpError(STATUS_NOT_FOUND, `user group '${input.id}' not found`);
    }
    await ctx.db
      .updateTable('userGroups')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    // A group's membership decides who a ring group rings, and the endpoints rendered for
    // them, so this matches `create` and `update` (§9.3).
    propagate(ctx, ['pjsip']);
    return { id: input.id };
  }
});
