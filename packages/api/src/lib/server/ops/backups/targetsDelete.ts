import { z } from 'zod';

import { liveRow, softDelete } from '../rows.js';
import { defineOperation } from '../types.js';

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
    await liveRow(
      ctx.db,
      'backupTargets',
      input.id,
      'backups: target not found'
    );
    await softDelete(ctx, 'backupTargets', input.id);
    return { id: input.id };
  }
});
