import { z } from 'zod';

import { recordChange } from '../audit.js';
import { loadDroppedBlfKeys } from '../devices/_shared.js';
import { propagate } from '../propagate.js';
import { pushRoster } from '../roster.js';
import { softDelete, softDeleteQuestion } from '../rows.js';
import { Conflict, defineOperation } from '../types.js';
import { findRingGroupReferences } from './_references.js';
import { liveRingGroup, ringGroupExtension } from './_shared.js';

export const deleteRingGroup = defineOperation({
  name: 'ringGroups.delete',
  description: 'Soft-deletes a ring group.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: async (ctx, input) => {
    const group = await liveRingGroup(ctx.db, input.id);
    const ext = await ringGroupExtension(ctx.db, input.id);
    return softDeleteQuestion(
      ctx,
      `the ring group ${group.name} (extension ${ext})`
    );
  },
  entity: input => ({ kind: 'ringGroup', id: input.id }),
  run: async (ctx, input) => {
    await liveRingGroup(ctx.db, input.id);
    const references = await findRingGroupReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('ring group is still in use', references);
    }
    const ext = await ringGroupExtension(ctx.db, input.id);
    const droppedBlfKeys = await loadDroppedBlfKeys(ctx, ext);
    await softDelete(ctx, 'ringGroups', input.id);
    await ctx.db
      .deleteFrom('extensions')
      .where('ringGroupId', '=', input.id)
      .execute();
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
