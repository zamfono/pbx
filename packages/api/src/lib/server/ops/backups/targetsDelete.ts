import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { loadLiveTarget } from './_shared.js';

const inputSchema = z.object({ id: z.string() }).strict();

/** `DELETE /backups/targets/{id}` (§6.5 "Backups", §5.9): soft-deletes a backup target. */
export const targetsDelete = defineOperation({
  name: 'backups.targets.delete',
  description: 'Soft-deletes a backup target; no further run backs up to it',
  input: inputSchema,
  minRole: 'admin',
  confirm: input => `Delete backup target ${input.id}?`,
  entity: input => ({ kind: 'backupTarget', id: input.id }),
  run: async (ctx, input) => {
    const target = await loadLiveTarget(ctx.db, input.id);
    if (!target) {
      throw new OpError(HTTP_NOT_FOUND, 'backups: target not found');
    }
    await ctx.db
      .updateTable('backupTargets')
      .set({ deletedAt: ctx.now })
      .where('id', '=', input.id)
      .execute();
    recordChange(ctx, { field: 'deletedAt', from: null, to: ctx.now });
    return { id: input.id };
  }
});
