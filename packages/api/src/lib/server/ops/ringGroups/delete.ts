import { z } from 'zod';

import { loadDroppedBlfKeys } from '../devices/_shared.js';
import { pushRoster } from '../roster.js';
import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, OpError } from '../types.js';
import { findRingGroupReferences } from './_references.js';
import { ringGroupExtension } from './_shared.js';

const STATUS_NOT_FOUND = 404;

export const deleteRingGroup = defineOperation({
  name: 'ringGroups.delete',
  description: 'Soft-deletes a ring group.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: input =>
    `Delete this ring group? The deletion can be undone for 30 days. (${input.id})`,
  entity: input => ({ kind: 'ringGroup', id: input.id }),
  run: async (ctx, input) => {
    const before = await ctx.db
      .selectFrom('ringGroups')
      .selectAll()
      .where('id', '=', input.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!before) {
      throw new OpError(STATUS_NOT_FOUND, `ring group '${input.id}' not found`);
    }
    const references = await findRingGroupReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('ring group is still in use', references);
    }
    const ext = await ringGroupExtension(ctx.db, input.id);
    const droppedBlfKeys = await loadDroppedBlfKeys(ctx, ext);
    await ctx.db
      .updateTable('ringGroups')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    await ctx.db
      .deleteFrom('extensions')
      .where('ringGroupId', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    recordChange(ctx, { field: 'ext', from: ext, to: null });
    if (droppedBlfKeys.length > 0) {
      recordChange(ctx, {
        field: 'droppedBlfKeys',
        from: droppedBlfKeys,
        to: []
      });
    }
    propagate(ctx, ['pjsip', 'dialplan']);
    await pushRoster(ctx);
    return { id: input.id };
  }
});
