import { z } from 'zod';

import { pushRoster } from '../roster.js';
import { propagate, recordChange } from '../runner.js';
import { Conflict, defineOperation, OpError, type Context } from '../types.js';
import { findRingGroupReferences } from './_references.js';
import { ringGroupExtension } from './_shared.js';

const STATUS_NOT_FOUND = 404;

type DroppedBlfKey = { deviceId: string; ext: string; position: number };

/**
 * The `device_blf_keys` rows the FK cascade drops when the group's extension is removed,
 * captured before the delete so the audit diff can record them (§5.9, §11.2 "extensions").
 */
async function loadDroppedBlfKeys(
  ctx: Context,
  ext: string
): Promise<DroppedBlfKey[]> {
  return ctx.db
    .selectFrom('deviceBlfKeys')
    .select(['deviceId', 'ext', 'position'])
    .where('ext', '=', ext)
    .execute();
}

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
