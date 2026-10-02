import { z } from 'zod';

import { propagate, recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import { liveUserGroup } from './_shared.js';

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
    await liveUserGroup(ctx.db, input.id);
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
